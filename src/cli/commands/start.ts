// `spendexpay-mcp start` — thin wrapper that boots the stdio MCP server.
//
// When `init` writes `.mcp.json`, it sets `command = "npx"` and
// `args = ["-y", "@spendexpay/mcp", "start"]`. The host agent (Claude Code,
// Cursor, …) spawns that command, which lands here.
//
// All this file does is dynamically import the real server entrypoint
// (`src/index.ts`, which becomes `dist/index.js`). We don't re-implement
// transport wiring — that lives in index.ts and is shared with the dev/start
// npm scripts.
//
// Dynamic import (not a top-level static import) is deliberate: it keeps the
// CLI's startup cost cheap for `spendexpay-mcp --help` and `spendexpay-mcp init`,
// neither of which should pay the cost of loading the MCP SDK, dotenv,
// Supabase client, etc.

export async function runStart(): Promise<void> {
  // The CLI lives at dist/cli/index.js; the server lives at dist/index.js.
  // Relative path from this file → ../../index.js after compilation.
  await import("../../index.js");
}
