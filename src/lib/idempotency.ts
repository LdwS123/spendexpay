// In-memory store for in-flight idempotency keys.
// Keys are added when a request starts and removed when it completes.
// A duplicate key while still in-flight returns a cached error.
// After completion the key is removed so legitimate retries (after failure) work.

// Build a Stripe-compatible idempotency key.
//
// Format: `{userId}-{service}-{projectName}-{Date.now()}`
//
// The millisecond timestamp is deliberate. Stripe caches PaymentIntent results
// for 24h keyed by this string. If a charge fails (decline, network timeout),
// reusing the same key returns the cached failure rather than re-running the
// charge. The timestamp ensures every retry attempt gets a fresh key.
//
// See CLAUDE.md → "Idempotency key format" for the canonical rationale.
export function buildIdempotencyKey(userId: string, service: string, projectName: string): string {
  return `${userId}-${service}-${projectName}-${Date.now()}`;
}

const inFlight = new Map<string, { startedAt: number }>();
const WINDOW_MS = 30_000; // 30 seconds — if a request hasn't completed in 30s, allow retry

export function acquireIdempotencyKey(key: string): boolean {
  // Returns true if the key was acquired (proceed), false if already in-flight (reject)
  const existing = inFlight.get(key);
  if (existing) {
    const age = Date.now() - existing.startedAt;
    if (age < WINDOW_MS) return false; // still in-flight
    // Stale — clean it up and allow
    inFlight.delete(key);
  }
  inFlight.set(key, { startedAt: Date.now() });
  return true;
}

export function releaseIdempotencyKey(key: string): void {
  inFlight.delete(key);
}

export function getInFlightCount(): number {
  return inFlight.size;
}
