// Pure retry utility — no imports from config.ts or db.ts.
// All debug output goes to console.error (stdout is reserved for MCP protocol).

import { ProviderError } from "./provider-error.js";

/**
 * Default retryOn predicate: retries on rate_limit, server_error, and network
 * ProviderError codes. Auth errors, quota errors, not_found, and conflict are
 * not retried because retrying them will never produce a different result.
 */
function defaultRetryOn(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return (
      err.code === "rate_limit" ||
      err.code === "server_error" ||
      err.code === "network"
    );
  }
  // Fallback for plain objects that carry a code property (e.g. raw fetch errors).
  const code = (err as { code?: unknown })?.code;
  return code === "rate_limit" || code === "server_error" || code === "network";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay between retries in milliseconds. Default: 1000 */
  delayMs?: number;
  /**
   * Predicate that decides whether to retry after a failure.
   * Return true to retry, false to rethrow immediately.
   * Default: retries on rate_limit, server_error, and network codes only.
   */
  retryOn?: (err: unknown) => boolean;
}

/**
 * Calls `fn` up to `maxAttempts` times, sleeping `delayMs * attempt` between
 * retries (linear backoff: 1×, 2×, …).  Only retries when `retryOn(err)` is
 * true; any other error is rethrown immediately on the first failure.
 * On exhaustion of all attempts, rethrows the last error as-is.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delayMs = options?.delayMs ?? 1000;
  const retryOn = options?.retryOn ?? defaultRetryOn;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isRetryable = retryOn(err);
      const hasMoreAttempts = attempt < maxAttempts;

      if (!isRetryable || !hasMoreAttempts) {
        throw err;
      }

      const waitMs = delayMs * attempt;
      console.error(
        `[retry] attempt ${attempt}/${maxAttempts} failed, retrying in ${waitMs}ms:`,
        err instanceof Error ? err.message : String(err)
      );
      await sleep(waitMs);
    }
  }

  // Should never reach here, but TypeScript needs the throw.
  throw lastError;
}
