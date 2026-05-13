/**
 * Tests for src/cli/commands/init.ts — the `spendexpay-mcp init` flow.
 *
 * Strategy:
 *   - Mock @inquirer/prompts so the test never blocks on stdin
 *   - Run runInit() against a fresh tmp directory
 *   - Assert .mcp.json exists, is valid JSON, and contains our token
 *
 * We exercise three real-world paths:
 *   1. Fresh project (no existing .mcp.json) — token via flag
 *   2. Fresh project with prompted token — covers the inquirer path
 *   3. Existing .mcp.json with another server — merge preserves it
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the prompts. The mock is configured per-test via mockResolvedValueOnce
// so we can vary token / dir answers across cases.
const inputMock = vi.fn();
const confirmMock = vi.fn();
vi.mock("@inquirer/prompts", () => ({
  input: (...args: unknown[]) => inputMock(...args),
  confirm: (...args: unknown[]) => confirmMock(...args),
}));

import {
  runInit,
  buildServerConfig,
  mergeMcpJson,
  validateToken,
} from "../../cli/commands/init.js";

const VALID_TOKEN = "spx_0123456789abcdef0123456789abcdef";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "spendexpay-cli-test-"));
  inputMock.mockReset();
  confirmMock.mockReset();
  // Silence the CLI's friendly stdout banner during tests.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("validateToken", () => {
  it("accepts a valid spx_<32hex> token", () => {
    expect(validateToken(VALID_TOKEN)).toBe(true);
  });

  it("rejects empty / wrong-format tokens", () => {
    expect(validateToken("")).toMatch(/required/i);
    expect(validateToken("not-a-token")).toMatch(/invalid/i);
    expect(validateToken("spx_TOOSHORT")).toMatch(/invalid/i);
    // Uppercase hex is not allowed — dashboard always emits lowercase.
    expect(validateToken("spx_0123456789ABCDEF0123456789ABCDEF")).toMatch(/invalid/i);
  });
});

describe("buildServerConfig", () => {
  it("returns the expected npx command + token env", () => {
    const cfg = buildServerConfig(VALID_TOKEN);
    expect(cfg).toEqual({
      command: "npx",
      args: ["-y", "@spendexpay/mcp", "start"],
      env: { SPENDEX_MCP_TOKEN: VALID_TOKEN },
    });
  });
});

describe("mergeMcpJson", () => {
  it("adds spendexpay to an empty config", () => {
    const result = mergeMcpJson({}, buildServerConfig(VALID_TOKEN));
    expect(result.mcpServers.spendexpay).toBeDefined();
  });

  it("preserves other servers while adding spendexpay", () => {
    const existing = {
      mcpServers: {
        supabase: { command: "npx", args: ["-y", "@supabase/mcp"] },
      },
    };
    const result = mergeMcpJson(existing, buildServerConfig(VALID_TOKEN));
    expect(result.mcpServers.supabase).toEqual(existing.mcpServers.supabase);
    expect(result.mcpServers.spendexpay.env?.SPENDEX_MCP_TOKEN).toBe(VALID_TOKEN);
  });
});

describe("runInit — happy paths", () => {
  it("writes .mcp.json when token is provided via opts (no prompt)", async () => {
    const path = await runInit({ token: VALID_TOKEN, dir: tmpDir });
    expect(path).toBe(join(tmpDir, ".mcp.json"));
    expect(existsSync(path)).toBe(true);

    // The file must be valid JSON and contain the token at the right path.
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.spendexpay.command).toBe("npx");
    expect(parsed.mcpServers.spendexpay.args).toEqual([
      "-y",
      "@spendexpay/mcp",
      "start",
    ]);
    expect(parsed.mcpServers.spendexpay.env.SPENDEX_MCP_TOKEN).toBe(VALID_TOKEN);

    // No prompts should have fired — both token and dir were supplied.
    expect(inputMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("prompts for token + dir when not supplied, then writes the file", async () => {
    inputMock
      .mockResolvedValueOnce(VALID_TOKEN) // token prompt
      .mockResolvedValueOnce(tmpDir); // dir prompt

    const path = await runInit({});
    expect(existsSync(path)).toBe(true);
    expect(inputMock).toHaveBeenCalledTimes(2);

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.spendexpay.env.SPENDEX_MCP_TOKEN).toBe(VALID_TOKEN);
  });

  it("merges into an existing .mcp.json by default, preserving other servers", async () => {
    const existingPath = join(tmpDir, ".mcp.json");
    writeFileSync(
      existingPath,
      JSON.stringify({
        mcpServers: {
          supabase: { command: "npx", args: ["-y", "@supabase/mcp"] },
        },
      }),
      "utf8",
    );

    await runInit({
      token: VALID_TOKEN,
      dir: tmpDir,
      onConflict: "merge",
    });

    const parsed = JSON.parse(readFileSync(existingPath, "utf8"));
    expect(parsed.mcpServers.supabase).toBeDefined();
    expect(parsed.mcpServers.spendexpay).toBeDefined();
    expect(parsed.mcpServers.spendexpay.env.SPENDEX_MCP_TOKEN).toBe(VALID_TOKEN);
  });

  it("overwrite mode replaces the entire file (drops other servers)", async () => {
    const existingPath = join(tmpDir, ".mcp.json");
    writeFileSync(
      existingPath,
      JSON.stringify({
        mcpServers: {
          supabase: { command: "npx", args: ["-y", "@supabase/mcp"] },
        },
      }),
      "utf8",
    );

    await runInit({
      token: VALID_TOKEN,
      dir: tmpDir,
      onConflict: "overwrite",
    });

    const parsed = JSON.parse(readFileSync(existingPath, "utf8"));
    expect(parsed.mcpServers.supabase).toBeUndefined();
    expect(parsed.mcpServers.spendexpay).toBeDefined();
  });
});

describe("runInit — error paths", () => {
  it("rejects an obviously bad token passed via opts", async () => {
    await expect(runInit({ token: "not-a-token", dir: tmpDir })).rejects.toThrow(
      /invalid token/i,
    );
    expect(existsSync(join(tmpDir, ".mcp.json"))).toBe(false);
  });

  it("refuses to clobber a corrupted existing .mcp.json", async () => {
    writeFileSync(join(tmpDir, ".mcp.json"), "{not json", "utf8");
    await expect(
      runInit({ token: VALID_TOKEN, dir: tmpDir, onConflict: "merge" }),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("errors if the target dir doesn't exist", async () => {
    await expect(
      runInit({ token: VALID_TOKEN, dir: join(tmpDir, "nope") }),
    ).rejects.toThrow(/does not exist/i);
  });
});
