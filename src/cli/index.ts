#!/usr/bin/env node
// Spendex Pay CLI — `spendexpay-mcp <subcommand>`.
//
// This is the binary that ships with the npm package. The two important
// subcommands today:
//
//   spendexpay-mcp init    Interactive setup — writes `.mcp.json` for the user
//   spendexpay-mcp start   Boots the stdio MCP server (used by Claude Code et al.)
//
// `init` is the user-facing one — the V1 wow moment. `start` is invoked by the
// host agent via `.mcp.json` and is not meant to be typed by humans.
//
// We use commander because it's the smallest sensible option (~50KB) with
// proper `--help`, exit codes, and subcommand routing. The alternative
// (hand-rolled argv parsing) ends up larger once help text is added.

import { Command } from "commander";
import { createRequire } from "node:module";

// Read version from package.json at runtime — avoids hardcoding it in two
// places (and a stale value during `npm version`). createRequire is needed
// because we're in ESM-land and can't `require()` directly.
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const program = new Command();

program
  .name("spendexpay-mcp")
  .description(
    "Spendex Pay — install the MCP server that lets your AI agent sign up to and pay for any service.",
  )
  .version(pkg.version, "-v, --version", "Print the package version");

program
  .command("init")
  .description("Interactive setup. Writes .mcp.json so your agent can find the spendexpay MCP server.")
  .option("--token <token>", "Provide the MCP token non-interactively (must match spx_<32hex>)")
  .option("--dir <dir>", "Target project directory (default: current dir)")
  .option("--overwrite", "Replace any existing .mcp.json instead of merging")
  .option("-y, --yes", "Skip confirmation prompts (assume defaults)")
  .action(async (opts: { token?: string; dir?: string; overwrite?: boolean; yes?: boolean }) => {
    // Lazy-load the command module so `--help` / `--version` don't pay the
    // cost of loading @inquirer/prompts (which pulls in a few hundred KB).
    const { runInit } = await import("./commands/init.js");
    try {
      await runInit({
        token: opts.token,
        dir: opts.dir,
        onConflict: opts.overwrite ? "overwrite" : undefined,
        yes: opts.yes,
      });
      process.exit(0);
    } catch (err) {
      // Inquirer throws `ExitPromptError` on Ctrl-C — treat that as a quiet
      // exit, not a stack trace. Anything else is a real error.
      const name = (err as { name?: string } | null)?.name;
      if (name === "ExitPromptError") {
        console.error("\nAborted.");
        process.exit(130);
      }
      console.error(`\nError: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("start")
  .description("Boot the stdio MCP server. Invoked by your agent via .mcp.json; not meant to be run directly.")
  .action(async () => {
    const { runStart } = await import("./commands/start.js");
    try {
      await runStart();
    } catch (err) {
      // Server startup failures must go to stderr — stdout is the MCP
      // JSON-RPC channel and any byte there breaks framing.
      console.error(`[spendexpay-mcp] start failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// commander prints help automatically if no args; we just need to call parse.
program.parseAsync(process.argv).catch((err) => {
  console.error(`[spendexpay-mcp] ${(err as Error).message}`);
  process.exit(1);
});
