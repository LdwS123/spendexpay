// `spendexpay-mcp init` — interactive bootstrap for the user's first install.
//
// Goal: a brand new user runs `npx @spendexpay/mcp init`, pastes their Spendex
// MCP token, and ends up with a working `.mcp.json` in their project that
// launches the spendexpay server via `npx -y @spendexpay/mcp start`. The whole
// flow must take under a minute; that's the V1 wow moment.
//
// IMPORTANT: this file runs in CLI context, NOT inside the MCP server process.
// stdout is for humans here (prompts, ✓ output) — see CLAUDE.md for the rule
// that stdout is sacred inside the server. That rule only applies to
// `src/index.ts` and the transport layer; the CLI is a sibling binary.

import { existsSync, readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import { resolve, join } from "node:path";
import { input, confirm } from "@inquirer/prompts";

/**
 * Spendex MCP tokens look like `spx_<32 hex chars>` — that's the format the
 * dashboard issues from /dashboard/tokens. We validate at the prompt layer so
 * users get instant feedback if they paste the wrong thing.
 */
const TOKEN_PATTERN = /^spx_[a-f0-9]{32}$/;

// ANSI colors — kept inline so we don't pull in `chalk` (saves ~20KB). The CLI
// detects NO_COLOR / non-TTY and degrades gracefully.
const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  green: (s: string) => (colorEnabled ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (colorEnabled ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (colorEnabled ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (colorEnabled ? `\x1b[36m${s}\x1b[0m` : s),
  bold: (s: string) => (colorEnabled ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (colorEnabled ? `\x1b[2m${s}\x1b[0m` : s),
};

export interface InitOptions {
  /** Skip prompts; used by tests. When set, all values must be provided. */
  token?: string;
  dir?: string;
  /** When `.mcp.json` exists, "merge" (default) preserves other servers; "overwrite" replaces the whole file. */
  onConflict?: "merge" | "overwrite";
  /** When true, write file even if non-interactive prompts can't run. */
  yes?: boolean;
}

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpJsonShape {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Builds the `.mcp.json` server config for spendexpay. The shape matches what
 * Claude Code, Cursor, and Windsurf all read.
 *
 * We use `npx -y @spendexpay/mcp start` (NOT `node ./dist/index.js`) because
 * the user installing via `npx` likely doesn't have the package cloned — npm
 * is the only delivery mechanism. The `-y` skips the "install this package?"
 * prompt that npx asks on first run.
 */
export function buildServerConfig(token: string): McpServerConfig {
  return {
    command: "npx",
    args: ["-y", "@spendexpay/mcp", "start"],
    env: {
      SPENDEX_MCP_TOKEN: token,
    },
  };
}

/**
 * Merges the spendexpay server entry into an existing `.mcp.json`, preserving
 * any other servers the user already has configured (e.g. Supabase, Stripe).
 */
export function mergeMcpJson(
  existing: unknown,
  serverConfig: McpServerConfig,
): McpJsonShape {
  const base: McpJsonShape =
    existing && typeof existing === "object" && "mcpServers" in existing
      ? (existing as McpJsonShape)
      : { mcpServers: {} };
  return {
    ...base,
    mcpServers: {
      ...base.mcpServers,
      spendexpay: serverConfig,
    },
  };
}

/**
 * Verifies the target directory exists and is writable. We check writability
 * up front so the user gets a clear error before we've prompted for anything
 * expensive (or, in the future, hit a network resolve endpoint).
 */
function assertWritableDir(dir: string): void {
  if (!existsSync(dir)) {
    throw new Error(`Directory does not exist: ${dir}`);
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new Error(`Directory is not writable: ${dir}`);
  }
}

/**
 * Validates a token string. Exported for the test suite — keeps the regex in
 * one place.
 */
export function validateToken(token: string): true | string {
  if (!token || typeof token !== "string") return "Token is required.";
  const trimmed = token.trim();
  if (!TOKEN_PATTERN.test(trimmed)) {
    return "Invalid token format. Expected `spx_` followed by 32 hex chars (get one at https://app.spendexai.com/dashboard/tokens).";
  }
  return true;
}

/**
 * The init command itself. Returns the path of the written `.mcp.json` so
 * tests (and any future programmatic callers) can assert on it.
 */
export async function runInit(opts: InitOptions = {}): Promise<string> {
  console.log("");
  console.log(c.bold("Spendex Pay — MCP setup"));
  console.log(c.dim("The agent that lives in your agents."));
  console.log("");

  // 1. Resolve the token. Either supplied via flag/test stub or prompted.
  let token = opts.token?.trim();
  if (!token) {
    token = await input({
      message:
        "Paste your Spendex MCP token (from https://app.spendexai.com/dashboard/tokens):",
      validate: validateToken,
    });
    token = token.trim();
  } else {
    const v = validateToken(token);
    if (v !== true) throw new Error(v);
  }

  // 2. Resolve target dir. Default = cwd.
  let targetDir = opts.dir;
  if (!targetDir) {
    const answer = await input({
      message: "Which directory is your Claude Code / Cursor project?",
      default: ".",
    });
    targetDir = answer || ".";
  }
  const absDir = resolve(process.cwd(), targetDir);
  assertWritableDir(absDir);

  // 3. Handle `.mcp.json` conflict.
  const mcpJsonPath = join(absDir, ".mcp.json");
  let mode: "merge" | "overwrite" = opts.onConflict ?? "merge";
  if (existsSync(mcpJsonPath) && !opts.onConflict && !opts.yes) {
    const ok = await confirm({
      message: `${c.yellow(".mcp.json")} already exists. Merge the spendexpay entry into it? (No = overwrite)`,
      default: true,
    });
    mode = ok ? "merge" : "overwrite";
  }

  // 4. Build the new file contents.
  const serverConfig = buildServerConfig(token);
  let nextJson: McpJsonShape;
  if (mode === "merge" && existsSync(mcpJsonPath)) {
    let existing: unknown = {};
    try {
      existing = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    } catch (err) {
      // Invalid JSON on disk — refuse to silently clobber. The user might
      // have hand-edited it. Surface the parse error and ask them to fix.
      throw new Error(
        `Existing .mcp.json is not valid JSON (${(err as Error).message}). ` +
          `Fix it manually or re-run with --overwrite.`,
      );
    }
    nextJson = mergeMcpJson(existing, serverConfig);
  } else {
    nextJson = { mcpServers: { spendexpay: serverConfig } };
  }

  // 5. Write. JSON.stringify with 2-space indent matches Claude Code's
  // convention so diffs against the user's existing file stay small.
  writeFileSync(mcpJsonPath, JSON.stringify(nextJson, null, 2) + "\n", "utf8");

  // 6. Friendly success output. The first-prompt suggestion is the V1
  // wow moment — show something the user will actually want to type next.
  console.log("");
  console.log(`${c.green("✓")} Wrote ${c.cyan(mcpJsonPath)} with the spendexpay server configured.`);
  console.log("");
  console.log(c.bold("Next:"));
  console.log(`  1. Restart your agent (Claude Code, Cursor, etc.)`);
  console.log(`  2. Try this prompt: ${c.cyan('"Top up my OpenAI for $20"')}`);
  console.log("");
  console.log(
    c.dim(
      "Need help? https://docs.spendexai.com  •  Manage rules: https://app.spendexai.com/dashboard",
    ),
  );
  console.log("");

  return mcpJsonPath;
}
