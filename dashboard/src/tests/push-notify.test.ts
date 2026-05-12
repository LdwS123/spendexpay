/**
 * Tests for src/lib/push-notify.ts and the /api/push/subscribe route.
 *
 * We mock the two boundaries that talk to the world:
 *   - `web-push`   → so no real push service is contacted
 *   - `@/lib/supabase` → so getAdminClient returns a fake builder we can
 *                       assert against
 *
 * The route handlers are imported and invoked with a fake NextRequest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// `web-push` ESM default-export form — we spy on setVapidDetails and
// sendNotification.
const setVapidDetails = vi.fn();
const sendNotification = vi.fn();

vi.mock("web-push", () => ({
  default: {
    setVapidDetails,
    sendNotification,
  },
  setVapidDetails,
  sendNotification,
}));

// In-memory fake Supabase admin: a chainable builder where each .eq() /
// .select() returns the same object, and the terminal call returns a
// thenable resolving to whatever we stored in `nextResult`.
type FakeRow = { push_subscription: unknown } | null;
const fakeState: {
  nextSelectRow: FakeRow;
  nextSelectError: { code?: string; message: string } | null;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
} = {
  nextSelectRow: null,
  nextSelectError: null,
  updates: [],
};

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.update = vi.fn((values: Record<string, unknown>) => {
    fakeState.updates.push({ table, values });
    return builder;
  });
  builder.maybeSingle = vi.fn(async () => ({
    data: fakeState.nextSelectRow,
    error: fakeState.nextSelectError,
  }));
  // For `await admin.from(...).update(...).eq(...)` — make the chain awaitable.
  (builder as { then?: unknown }).then = (
    resolve: (v: { data: null; error: null }) => unknown
  ) => resolve({ data: null, error: null });
  return builder;
}

vi.mock("@/lib/supabase", () => ({
  getAdminClient: () => ({
    from: (table: string) => makeBuilder(table),
  }),
}));

// Route helper: we don't run a full Next request, we construct one manually.
// `@/lib/supabase/server` is used by the route to read the auth session.
const getUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: () => getUser(),
    },
  }),
}));

// ─── Tests for push-notify.ts ────────────────────────────────────────────────

describe("sendPushToUser", () => {
  beforeEach(() => {
    setVapidDetails.mockReset();
    sendNotification.mockReset();
    fakeState.nextSelectRow = null;
    fakeState.nextSelectError = null;
    fakeState.updates = [];
    // Reset module-level VAPID configuration cache between tests.
    vi.resetModules();
    process.env.VAPID_PUBLIC_KEY = "test_public_key";
    process.env.VAPID_PRIVATE_KEY = "test_private_key";
    process.env.VAPID_SUBJECT = "mailto:test@spendexai.com";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  });

  it("calls web-push.sendNotification with the stored subscription and a JSON-encoded payload", async () => {
    fakeState.nextSelectRow = {
      push_subscription: {
        endpoint: "https://push.example.com/abc",
        expirationTime: null,
        keys: { p256dh: "p256dh-value", auth: "auth-value" },
      },
    };
    sendNotification.mockResolvedValueOnce({ statusCode: 201 });

    const { sendPushToUser } = await import("../lib/push-notify");
    const result = await sendPushToUser("user-123", {
      title: "Spendex needs your input",
      body: "Your agent wants to pay $5 on vercel.",
      action_url: "https://app.spendexai.com/dashboard/consents/abc",
    });

    expect(result).toEqual({ ok: true });
    expect(setVapidDetails).toHaveBeenCalledWith(
      "mailto:test@spendexai.com",
      "test_public_key",
      "test_private_key"
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [target, body] = sendNotification.mock.calls[0];
    expect(target).toEqual({
      endpoint: "https://push.example.com/abc",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    });
    // Body is a JSON string with the exact shape the SW will read.
    expect(JSON.parse(body as string)).toEqual({
      title: "Spendex needs your input",
      body: "Your agent wants to pay $5 on vercel.",
      action_url: "https://app.spendexai.com/dashboard/consents/abc",
    });
  });

  it("returns ok:false without sending when no subscription is on file", async () => {
    fakeState.nextSelectRow = { push_subscription: null };

    const { sendPushToUser } = await import("../lib/push-notify");
    const result = await sendPushToUser("user-456", {
      title: "x",
      body: "y",
      action_url: "/dashboard/consents",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no push subscription/i);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("clears the subscription when the push service returns 410 Gone", async () => {
    fakeState.nextSelectRow = {
      push_subscription: {
        endpoint: "https://push.example.com/abc",
        expirationTime: null,
        keys: { p256dh: "p", auth: "a" },
      },
    };
    sendNotification.mockRejectedValueOnce(
      Object.assign(new Error("Gone"), { statusCode: 410 })
    );

    const { sendPushToUser } = await import("../lib/push-notify");
    const result = await sendPushToUser("user-789", {
      title: "x",
      body: "y",
      action_url: "/",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/410/);
    // We should have issued an UPDATE setting push_subscription to null.
    const cleared = fakeState.updates.find(
      (u) => u.table === "users" && u.values.push_subscription === null
    );
    expect(cleared).toBeTruthy();
  });
});

// ─── Tests for the subscribe API route ──────────────────────────────────────

describe("POST /api/push/subscribe", () => {
  beforeEach(() => {
    vi.resetModules();
    fakeState.nextSelectRow = null;
    fakeState.nextSelectError = null;
    fakeState.updates = [];
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    getUser.mockReset();
  });

  function makeRequest(body: unknown): Request {
    return new Request("http://localhost/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("stores a well-formed PushSubscription on the user row", async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: "user-abc" } },
      error: null,
    });
    const { POST } = await import("../app/api/push/subscribe/route");

    const sub = {
      endpoint: "https://push.example.com/sub-1",
      expirationTime: null,
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    };
    const res = await POST(makeRequest(sub) as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true });

    const update = fakeState.updates.find((u) => u.table === "users");
    expect(update).toBeTruthy();
    expect(update?.values.push_subscription).toEqual(sub);
  });

  it("rejects bodies missing the endpoint or keys", async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: "user-abc" } },
      error: null,
    });
    const { POST } = await import("../app/api/push/subscribe/route");

    const res = await POST(
      makeRequest({ endpoint: "https://x", keys: { p256dh: "x" } }) as unknown as Parameters<typeof POST>[0]
    );
    expect(res.status).toBe(400);
    expect(fakeState.updates).toHaveLength(0);
  });

  it("returns 401 when no authenticated user is present", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const { POST } = await import("../app/api/push/subscribe/route");

    const res = await POST(
      makeRequest({
        endpoint: "https://x",
        keys: { p256dh: "p", auth: "a" },
      }) as unknown as Parameters<typeof POST>[0]
    );
    expect(res.status).toBe(401);
  });
});
