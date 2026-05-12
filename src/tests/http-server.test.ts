/**
 * Tests for src/http-server.ts — the Streamable HTTP transport.
 *
 * Strategy: bind the Express app to port 0 (kernel-assigned), hit it with
 * the global `fetch` API (Node 20+), and assert against real HTTP responses.
 * No supertest dependency required, no mocking the MCP transport — we want
 * to be sure the wiring actually works end-to-end.
 *
 * Each test boots a fresh server so port assignment is deterministic and we
 * don't accidentally share Express middleware state across tests.
 *
 * SPENDEX_DEV=true is set in `beforeAll` so the underlying tools can be
 * registered without real Supabase/Stripe credentials. The test only
 * exercises the transport layer (initialize, tools/list, CORS, health),
 * not any tool that actually moves money.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

let createHttpApp: typeof import("../http-server.js").createHttpApp;

beforeAll(async () => {
  // Tools call validateConfig() at startup in production, but the HTTP
  // factory itself does not — it just registers tools. Setting
  // SPENDEX_DEV=true keeps any tool that *does* check env vars happy.
  process.env["SPENDEX_DEV"] = "true";
  ({ createHttpApp } = await import("../http-server.js"));
});

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const app = createHttpApp();
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, () => resolve());
    server.once("error", reject);
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Parse a Streamable HTTP response. The transport may reply as either:
 *   - application/json — single JSON-RPC object
 *   - text/event-stream — one or more SSE `data: …` frames
 * We accept both and return the first JSON-RPC message.
 */
async function parseMcpResponse(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (ct.includes("application/json")) {
    return JSON.parse(body);
  }
  if (ct.includes("text/event-stream")) {
    // Pull the first `data:` line out of the SSE payload.
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        return JSON.parse(line.slice(5).trim());
      }
    }
    throw new Error(`No data frame in SSE body: ${body.slice(0, 200)}`);
  }
  throw new Error(`Unexpected content-type ${ct}: ${body.slice(0, 200)}`);
}

describe("Streamable HTTP server", () => {
  it("POST /mcp with initialize → returns 200 + protocolVersion", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1.0.0" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const parsed = (await parseMcpResponse(res)) as {
      jsonrpc: string;
      id: number;
      result?: { protocolVersion?: string; serverInfo?: { name: string } };
    };
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(1);
    expect(parsed.result).toBeDefined();
    expect(typeof parsed.result!.protocolVersion).toBe("string");
    expect(parsed.result!.serverInfo?.name).toBe("spendex-pay");
  });

  it("POST /mcp with tools/list → returns tools array", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    expect(res.status).toBe(200);
    const parsed = (await parseMcpResponse(res)) as {
      jsonrpc: string;
      id: number;
      result?: { tools: Array<{ name: string }> };
    };
    expect(parsed.result).toBeDefined();
    expect(Array.isArray(parsed.result!.tools)).toBe(true);
    // We register 20+ tools (PRIMARY + INTROSPECTION + LEGACY).
    expect(parsed.result!.tools.length).toBeGreaterThanOrEqual(20);
    const names = parsed.result!.tools.map((t) => t.name);
    expect(names).toContain("pay_for_service");
    expect(names).toContain("signup_to_service");
    expect(names).toContain("check_balance");
    expect(names).toContain("deploy_to_vercel");
  });

  it("POST /mcp with invalid JSON → returns 400", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number } };
    // Our parse-error handler returns a JSON-RPC -32700 (Parse error).
    expect(body.error?.code).toBe(-32700);
  });

  it("GET /health → returns 200 OK with version", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
  });

  it("GET /mcp → returns 405 Method Not Allowed", async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("OPTIONS /mcp → returns CORS headers", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://claude.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://claude.ai"
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "Content-Type"
    );
  });

  it("GET / → returns HTML landing page", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Spendex MCP server");
    expect(body).toContain("POST /mcp");
  });
});
