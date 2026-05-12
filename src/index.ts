#!/usr/bin/env node
// stdio entry point — Claude Code, Cursor, and other local MCP clients spawn
// this process and communicate over stdin/stdout. The HTTP entry point lives
// in src/http-server.ts and reuses the same tool registration helper.
//
// Tool registration order — primary surface first, then introspection, then
// legacy fallback — is encoded in src/lib/register-all-tools.ts and shared
// between both transports.

// Load .env from the repo root so the MCP server has the same env as the
// dashboard. Done before any other imports so config validation can read the
// values. The HTTP transport does NOT load .env — its env vars come from the
// container/host (Fly.io, Docker, etc.).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
const __dirname = dirname(fileURLToPath(import.meta.url));
// quiet: true is critical — dotenv prints a banner to stdout by default, which
// corrupts the JSON-RPC framing on the stdio transport. The MCP protocol uses
// stdout exclusively; nothing else may write a single byte there before connect.
dotenv.config({ path: resolve(__dirname, "../.env"), quiet: true });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateConfig } from "./config.js";
import { registerAllTools } from "./lib/register-all-tools.js";

const server = new McpServer({
  name: "spendex-pay",
  version: "0.1.0",
});

registerAllTools(server);

async function main() {
  // Validate required env vars before doing anything else.
  // Throws with actionable error messages if any are missing or malformed.
  // No-ops when SPENDEX_DEV=true (dev mode uses placeholders).
  validateConfig();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for MCP protocol messages (stdio transport)
  console.error("Spendex Pay MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting Spendex Pay:", error);
  process.exit(1);
});
