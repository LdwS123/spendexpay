// Streamable HTTP entry point — exposes the same MCP surface as src/index.ts
// over a plain HTTP endpoint so web-based MCP clients (claude.ai, custom
// GPTs, Cursor in remote mode, etc.) can connect via URL instead of stdio.
//
// Design choices:
//   - Stateless transport. Each POST /mcp gets a fresh `McpServer` +
//     `StreamableHTTPServerTransport` pair. No session state on the server,
//     so we can horizontally scale by adding pods without sticky sessions.
//   - Auth lives in each tool, not at the HTTP layer. Tools take `mcp_token`
//     in their arguments and look up the user via the Supabase wrapper.
//     Adding a per-request bearer check here would just duplicate work the
//     tools already do.
//   - No dotenv. The HTTP server is meant to be deployed (Fly.io, Docker,
//     Railway, etc.) where env vars come from the host. Local stdio dev
//     still loads .env via src/index.ts.
//
// Endpoints:
//   POST /mcp     → MCP JSON-RPC traffic (Streamable HTTP transport)
//   GET  /mcp     → 405 (Streamable HTTP doesn't use GET for data)
//   GET  /health  → liveness probe, returns { status, version }
//   GET  /        → human-readable landing page

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateConfig } from "./config.js";
import { registerAllTools } from "./lib/register-all-tools.js";

const SERVER_NAME = "spendex-pay";
const SERVER_VERSION = "0.1.0";

// Origins allowed to talk to this server from the browser. `*` is included
// for dev tooling, but production-friendly clients (claude.ai, chatgpt.com)
// are listed explicitly so we can swap `*` out later without breaking them.
const ALLOWED_ORIGINS = new Set<string>([
  "https://claude.ai",
  "https://chatgpt.com",
  "*",
]);

/**
 * Apply CORS headers for MCP web clients. Streamable HTTP runs cross-origin
 * from claude.ai / chatgpt.com, so the preflight has to succeed before any
 * JSON-RPC traffic flows.
 */
function applyCors(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

/**
 * Best-effort tool-name extraction for log lines. Streamable HTTP can carry
 * an array of JSON-RPC messages, so we pick the first one with a method.
 * Never throws — logging must never break a real request.
 */
function pickToolName(body: unknown): string | undefined {
  const pickFrom = (obj: unknown): string | undefined => {
    if (!obj || typeof obj !== "object") return undefined;
    const rec = obj as Record<string, unknown>;
    const method = typeof rec["method"] === "string" ? (rec["method"] as string) : undefined;
    if (method === "tools/call") {
      const params = rec["params"];
      if (params && typeof params === "object") {
        const name = (params as Record<string, unknown>)["name"];
        if (typeof name === "string") return `tools/call:${name}`;
      }
      return "tools/call";
    }
    return method;
  };
  if (Array.isArray(body)) {
    for (const entry of body) {
      const name = pickFrom(entry);
      if (name) return name;
    }
    return undefined;
  }
  return pickFrom(body);
}

/**
 * Build the Express app. Exported so tests can mount it via supertest-style
 * helpers without going through `listen()`.
 */
export function createHttpApp(): Express {
  const app = express();

  // JSON body parser — Streamable HTTP's `handleRequest(req, res, req.body)`
  // expects the body already parsed. Limit guards against runaway payloads.
  app.use(express.json({ limit: "1mb" }));

  // Reject malformed JSON with 400 before it hits the MCP transport. Express
  // emits a SyntaxError from body-parser; we surface it as a JSON-RPC-ish
  // error response so clients can distinguish "bad request" from "MCP
  // failure".
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      applyCors(req, res);
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: invalid JSON body" },
        id: null,
      });
      return;
    }
    next(err);
  });

  // CORS preflight — Streamable HTTP clients always send a preflight for
  // cross-origin POSTs.
  app.options("/mcp", (req, res) => {
    applyCors(req, res);
    res.status(204).end();
  });

  // ---------------------------------------------------------------------------
  // POST /mcp — primary MCP JSON-RPC endpoint.
  //
  // Per Streamable HTTP spec we create a transport per request. The McpServer
  // is also re-created so that no per-request state leaks across calls; this
  // keeps the deployment stateless and lets us scale horizontally without
  // sticky sessions.
  // ---------------------------------------------------------------------------
  app.post("/mcp", async (req, res) => {
    applyCors(req, res);
    const startedAt = Date.now();
    const toolName = pickToolName(req.body) ?? "unknown";

    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    registerAllTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // If the client disconnects mid-request, drop the transport so we don't
    // leak handles. Best-effort: never block the response on this.
    res.on("close", () => {
      transport.close().catch((err: unknown) => {
        console.error(
          "[spendex-http] transport close failed:",
          err instanceof Error ? err.message : err
        );
      });
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error("[spendex-http] POST /mcp failed:", message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      const ms = Date.now() - startedAt;
      console.error(`[spendex-http] POST /mcp ${toolName} ${ms}ms`);
    }
  });

  // Streamable HTTP doesn't define a GET handler for data — only POST.
  // Returning 405 (instead of 404) tells the client the route exists but
  // the verb is wrong, which is the standards-compliant response.
  app.get("/mcp", (req, res) => {
    applyCors(req, res);
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({
      error: "Method Not Allowed. Use POST /mcp for MCP JSON-RPC traffic.",
    });
  });

  // Health endpoint for load balancers / uptime probes.
  app.get("/health", (req, res) => {
    applyCors(req, res);
    res.status(200).json({ status: "ok", version: SERVER_VERSION });
  });

  // Landing page — useful when a curious dev hits the root URL in a browser.
  app.get("/", (req, res) => {
    applyCors(req, res);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Spendex MCP server</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 64px auto; padding: 0 24px; background: #070d18; color: #e6edf6; }
  h1 { color: #00e5b4; margin-bottom: 8px; }
  code { background: #11192a; padding: 2px 6px; border-radius: 4px; color: #00e5b4; }
  a { color: #00e5b4; }
</style>
</head>
<body>
<h1>Spendex MCP server</h1>
<p>The wallet that lives in your agents. Connect via <code>POST /mcp</code> with a Streamable HTTP MCP client.</p>
<ul>
  <li><code>POST /mcp</code> — JSON-RPC over Streamable HTTP</li>
  <li><code>GET /health</code> — liveness probe</li>
</ul>
<p>Docs: <a href="https://spendexai.com">spendexai.com</a></p>
</body>
</html>`
    );
  });

  return app;
}

/**
 * Boot the HTTP server. Only called when this file is the process entry
 * point (i.e. `node dist/http-server.js`). Importing the module for tests
 * does NOT trigger a listen.
 */
async function main(): Promise<void> {
  validateConfig();
  const portRaw = process.env["PORT"];
  const port = portRaw ? Number.parseInt(portRaw, 10) : 3001;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT env var: ${portRaw ?? "(unset)"}`);
  }
  const app = createHttpApp();
  app.listen(port, () => {
    console.error(
      `[spendex-http] Spendex Pay MCP server (HTTP) listening on :${port}`
    );
  });
}

// Detect "run as entry point" without relying on require.main (ESM-safe).
const isEntryPoint = (() => {
  try {
    const argvHref = process.argv[1]
      ? new URL(`file://${process.argv[1]}`).href
      : "";
    return import.meta.url === argvHref;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error("[spendex-http] Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
