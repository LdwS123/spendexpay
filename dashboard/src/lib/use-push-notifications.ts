/**
 * Web Push notifications — client-side hooks.
 *
 * The dashboard registers `/public/sw.js` once per browser, then asks the
 * Push Manager for a subscription bound to our VAPID public key. The
 * subscription (endpoint + keys) is POSTed to /api/push/subscribe so the
 * server can later send notifications via the web-push npm package.
 *
 * Graceful degradation is critical: Safari < 16, Firefox in some private
 * modes, and any browser where the user blocks notifications must not throw.
 * Every helper here either returns a useful value or rejects with a typed
 * `PushError` the caller can render verbatim.
 *
 * Design notes:
 *  - All functions are pure (no React state). The settings page wraps them
 *    in `useState` / `useEffect` directly; we don't ship a React hook here
 *    because there's no shared state worth lifting.
 *  - We never store the VAPID *private* key client-side. The public key
 *    is exposed as NEXT_PUBLIC_VAPID_PUBLIC_KEY at build time — it's safe
 *    to leak (signing happens server-side only).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type PushErrorCode =
  | "unsupported" // No Push API / Notification API / Service Worker support.
  | "permission_denied" // User refused Notification.requestPermission().
  | "no_vapid_key" // NEXT_PUBLIC_VAPID_PUBLIC_KEY missing.
  | "subscribe_failed" // pushManager.subscribe rejected.
  | "server_rejected"; // POST /api/push/subscribe returned non-2xx.

export class PushError extends Error {
  readonly code: PushErrorCode;
  constructor(code: PushErrorCode, message: string) {
    super(message);
    this.name = "PushError";
    this.code = code;
  }
}

/** Wire shape posted to /api/push/subscribe. */
export interface PushSubscriptionWire {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// ─── Capability detection ─────────────────────────────────────────────────────

/**
 * True when this browser supports the full Push API stack:
 *   1. Service workers (Safari ≥ 11)
 *   2. PushManager on the SW registration (Safari ≥ 16, iOS only when added
 *      to home screen as a PWA)
 *   3. The Notification permission model
 *
 * SSR-safe: returns false during prerender (window/navigator are undefined).
 */
export function isPushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * True iff the user has *already* subscribed in this browser. Reads from the
 * SW registration synchronously when possible, otherwise falls back to
 * checking the granted permission. Returns false on any error.
 */
export function isPushEnabled(): boolean {
  if (!isPushSupported()) return false;
  // Best the synchronous API can do — full check is async via
  // `getCurrentSubscription`. We use this for initial render hints; the
  // settings page reconciles with the async check on mount.
  return Notification.permission === "granted";
}

/**
 * Async version of `isPushEnabled` that actually inspects the SW for a
 * PushSubscription. Use this from useEffect to populate the toggle state.
 */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// ─── Subscribe / unsubscribe ──────────────────────────────────────────────────

/**
 * Register /sw.js (idempotent — the browser dedupes) and subscribe to push.
 * The resulting subscription is POSTed to /api/push/subscribe so the server
 * can later use it as the target for web-push.sendNotification.
 *
 * Throws PushError on every failure path so the caller can show a precise
 * message ("Notifications blocked in your OS settings" vs "Browser too old").
 */
export async function subscribeToPush(): Promise<PushSubscription> {
  if (!isPushSupported()) {
    throw new PushError(
      "unsupported",
      "Push notifications aren't supported in this browser."
    );
  }

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) {
    throw new PushError(
      "no_vapid_key",
      "Push notifications aren't configured on this server."
    );
  }

  // 1. Permission. Some browsers fold this into the subscribe() call, but
  //    calling requestPermission() first gives us a clean failure mode that
  //    doesn't leave a dangling registration.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushError(
      "permission_denied",
      "Notification permission was denied."
    );
  }

  // 2. Service worker registration. We pin scope to '/' so the same SW
  //    handles every dashboard route.
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });
    // Wait for the SW to be active before subscribing — some browsers reject
    // pushManager.subscribe on a still-installing SW.
    if (!registration.active) {
      await navigator.serviceWorker.ready;
    }
  } catch (err) {
    throw new PushError(
      "subscribe_failed",
      err instanceof Error ? err.message : "Service worker registration failed."
    );
  }

  // 3. Subscribe via PushManager. The VAPID key has to be a Uint8Array.
  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true, // required on Chrome/Firefox/Safari
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  } catch (err) {
    throw new PushError(
      "subscribe_failed",
      err instanceof Error ? err.message : "Push subscription failed."
    );
  }

  // 4. Ship the subscription to the server. If this fails the SW is still
  //    registered (harmless), so we don't try to roll back — a retry on the
  //    same UI flow will pick up the existing subscription and POST it again.
  const wire = subscriptionToWire(subscription);
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wire),
  });
  if (!res.ok) {
    throw new PushError(
      "server_rejected",
      `Server rejected subscription (HTTP ${res.status}).`
    );
  }

  return subscription;
}

/**
 * Tear down the current subscription, both locally (PushManager.unsubscribe)
 * and on the server (DELETE /api/push/subscribe). Idempotent — fine to call
 * when there's no active subscription.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await sub.unsubscribe();
    }
  } catch {
    // Best-effort: continue to clear server-side even if the local call fails.
  }
  // Always clear server side — the user clicked "off" and that decision
  // outranks our ability to talk to the browser's push service.
  await fetch("/api/push/subscribe", { method: "DELETE" });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * VAPID keys come down as URL-safe base64 strings (RFC 4648 §5). The Push
 * API wants a raw ArrayBuffer. This is the reference conversion published
 * in the W3C spec — handles padding and the `-`/`_` alphabet. We return
 * an ArrayBuffer (rather than a Uint8Array view) because the modern lib.dom
 * typing of `PushSubscriptionOptionsInit.applicationServerKey` rejects
 * Uint8Array<ArrayBufferLike> as of TS 5.6 — the underlying ArrayBuffer is
 * the always-accepted shape.
 */
function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    view[i] = rawData.charCodeAt(i);
  }
  return buffer;
}

/**
 * Convert the live `PushSubscription` (with binary keys) to the JSON shape
 * our API route expects. `PushSubscription#toJSON()` already produces the
 * right shape on modern browsers, but we re-extract explicitly to keep the
 * wire contract typed.
 */
export function subscriptionToWire(sub: PushSubscription): PushSubscriptionWire {
  const json = sub.toJSON() as {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: { p256dh?: string; auth?: string };
  };
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new PushError(
      "subscribe_failed",
      "Browser returned an incomplete PushSubscription."
    );
  }
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}
