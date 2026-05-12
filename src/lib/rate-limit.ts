// Token bucket rate limiter — per MCP token, in-memory.
// No external dependencies (no Redis). Resets on server restart.
// Replace with Upstash Redis when running multiple instances.

const MINUTE_LIMIT = 10;
const MINUTE_WINDOW_MS = 60_000;

const HOUR_LIMIT = 50;
const HOUR_WINDOW_MS = 3_600_000;

const STALE_THRESHOLD_MS = HOUR_WINDOW_MS;

interface TokenEntry {
  minuteCount: number;
  minuteWindowStart: number;
  hourCount: number;
  hourWindowStart: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Only present when allowed === false. Milliseconds until the earliest
   *  window resets and the caller may retry. */
  retryAfterMs?: number;
}

const store = new Map<string, TokenEntry>();

function pruneStaleEntries(now: number): void {
  for (const [token, entry] of store) {
    const minuteExpiry = entry.minuteWindowStart + MINUTE_WINDOW_MS;
    const hourExpiry = entry.hourWindowStart + HOUR_WINDOW_MS;
    if (now > minuteExpiry && now > hourExpiry) {
      store.delete(token);
    }
  }
}

/**
 * Check whether `mcpToken` is within its rate-limit budget and, if so,
 * consume one request from both windows.
 *
 * @param mcpToken - The raw MCP token string from the tool input.
 *   We deliberately do not validate its format here; the point is to
 *   limit by token identity before we hit the DB, even for invalid tokens.
 */
export function checkRateLimit(mcpToken: string): RateLimitResult {
  try {
    const now = Date.now();

    pruneStaleEntries(now);

    let entry = store.get(mcpToken);

    if (entry === undefined) {
      entry = {
        minuteCount: 0,
        minuteWindowStart: now,
        hourCount: 0,
        hourWindowStart: now,
      };
      store.set(mcpToken, entry);
    }

    if (now - entry.minuteWindowStart >= MINUTE_WINDOW_MS) {
      entry.minuteCount = 0;
      entry.minuteWindowStart = now;
    }

    if (now - entry.hourWindowStart >= HOUR_WINDOW_MS) {
      entry.hourCount = 0;
      entry.hourWindowStart = now;
    }

    // Check before incrementing so the limit is exactly N, not N+1.
    if (entry.minuteCount >= MINUTE_LIMIT) {
      const retryAfterMs = entry.minuteWindowStart + MINUTE_WINDOW_MS - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1) };
    }

    if (entry.hourCount >= HOUR_LIMIT) {
      const retryAfterMs = entry.hourWindowStart + HOUR_WINDOW_MS - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1) };
    }

    entry.minuteCount += 1;
    entry.hourCount += 1;

    return { allowed: true };
  } catch (err) {
    // Fail-open: if there is an unexpected bug in the rate limiter itself,
    // log it and allow the request through rather than breaking the server.
    console.error("[rate-limit] Unexpected error in checkRateLimit:", err);
    return { allowed: true };
  }
}
