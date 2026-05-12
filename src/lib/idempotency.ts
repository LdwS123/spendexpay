// In-memory store for in-flight idempotency keys.
// Keys are added when a request starts and removed when it completes.
// A duplicate key while still in-flight returns a cached error.
// After completion the key is removed so legitimate retries (after failure) work.

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
