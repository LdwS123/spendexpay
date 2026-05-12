/**
 * Shared authentication boilerplate for MCP tool handlers.
 *
 * Every chargeable tool runs the same four checks in the same order before it
 * touches a payment path: rate-limit, emergency-stop, token-format, user lookup.
 * Copy-pasting that ladder across each tool was a source of subtle drift —
 * error wording, ordering, and isError flags all need to match exactly so the
 * agent's recovery logic behaves predictably.
 *
 * Callers handle DEV_MODE themselves (it short-circuits with a tool-specific
 * simulated response BEFORE auth runs), so this helper is purely the
 * production-mode gate.
 *
 * Order matters and mirrors what the legacy inline code did:
 *
 *   1. Rate-limit — runs before any DB read so a runaway agent can't hammer
 *      the DB and so timing of a bad token vs. a valid-but-unknown token is
 *      indistinguishable.
 *   2. Emergency stop — kill-switch readable via env var, no restart needed.
 *   3. Token format — cheap regex check; rejects "obviously wrong" tokens
 *      before a DB roundtrip.
 *   4. User lookup — final DB call resolving the token to a SpendexUser row.
 *
 * Each failure returns a `ToolTextResponse` with the same exact wording the
 * inline code used; tests assert on those strings, so changing them is a
 * breaking change for the agent contract too.
 */

import { config } from "../config.js";
import { getUserByMcpToken, type SpendexUser } from "./db.js";
import { checkRateLimit } from "./rate-limit.js";

// Format: "spx_" + 32 lowercase hex chars. Defined once here so every tool
// validates the same shape.
const MCP_TOKEN_PATTERN = /^spx_[0-9a-f]{32}$/;

export interface ToolTextResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // Index signature required by @modelcontextprotocol/sdk's tool response type
  // (it accepts arbitrary extra fields under content/_meta). Mirrors the
  // structural shape the inline `textResponse` helpers used to produce via
  // inference rather than an explicit interface.
  [x: string]: unknown;
}

export type AuthenticateToolCallResult =
  | { ok: true; user: SpendexUser }
  | { ok: false; response: ToolTextResponse };

function textResponse(text: string, opts: { isError?: boolean } = {}): ToolTextResponse {
  return {
    content: [{ type: "text", text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

/**
 * Run the shared rate-limit / emergency-stop / token-format / user-lookup
 * ladder. Returns the authenticated SpendexUser on success, or a ready-to-
 * return MCP text response describing the failure.
 *
 * Callers must handle DEV_MODE themselves before invoking this — the helper
 * always touches real state (rate-limit store, config getter, DB).
 */
export async function authenticateToolCall(
  mcpToken: string
): Promise<AuthenticateToolCallResult> {
  const rateLimit = checkRateLimit(mcpToken);
  if (!rateLimit.allowed) {
    const waitSeconds = Math.ceil((rateLimit.retryAfterMs ?? 0) / 1000);
    return {
      ok: false,
      response: textResponse(
        `Too many requests. Please wait ${waitSeconds} second${waitSeconds === 1 ? "" : "s"} before trying again.`,
        { isError: true }
      ),
    };
  }

  if (config.emergencyStop) {
    return {
      ok: false,
      response: textResponse(
        "Spendex Pay is temporarily paused for maintenance. Please try again later.",
        { isError: true }
      ),
    };
  }

  if (!MCP_TOKEN_PATTERN.test(mcpToken)) {
    return {
      ok: false,
      response: textResponse(
        "Invalid MCP token format. A Spendex token looks like `spx_…` " +
        "(32 hex chars). Get yours at spendexai.com/dashboard/tokens.",
        { isError: true }
      ),
    };
  }

  const user = await getUserByMcpToken(mcpToken);
  if (!user) {
    return {
      ok: false,
      response: textResponse(
        "Invalid or expired MCP token. Please reconnect at spendexai.com/connect.",
        { isError: true }
      ),
    };
  }

  return { ok: true, user };
}
