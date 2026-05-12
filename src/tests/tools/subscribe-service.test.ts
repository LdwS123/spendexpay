/**
 * Tests for src/tools/subscribe-service.ts
 *
 * Covers both the new `subscribe_service` tool (registerSubscribeService) and
 * the legacy `subscribe_to_service` tool (registerSubscribeServiceTool) kept
 * for backwards compatibility. The handlers are captured via a fake McpServer
 * so each one can be invoked directly.
 *
 * All I/O is mocked (DB, rate-limit, payment router, tool-auth) so no
 * network calls or real Stripe/Supabase connections are made.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must appear before any imports that touch these modules.
// vi.mock is hoisted to the top of the file by Vitest.
// ---------------------------------------------------------------------------

vi.mock("../../lib/db.js", () => ({
  // New subscribe_service surface
  createSubscription: vi.fn(),
  computeNextChargeAt: vi.fn(
    (from: Date, _interval: string) => new Date(from.getTime() + 30 * 86400000)
  ),
  getRulesForUser: vi.fn(),
  getMonthlySpendUsd: vi.fn(),
  // Shared
  getUserByMcpToken: vi.fn(),
  logTransaction: vi.fn(),
}));

vi.mock("../../lib/tool-auth.js", () => ({
  authenticateToolCall: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("../../config.js", () => {
  const cfg = { emergencyStop: false };
  return { config: cfg, DEV_MODE: false };
});

vi.mock("../../lib/payments/router.js", () => ({
  routePayment: vi.fn(),
}));

vi.mock("../../lib/idempotency.js", () => ({
  acquireIdempotencyKey: vi.fn(),
  releaseIdempotencyKey: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  createSubscription,
  getRulesForUser,
  getMonthlySpendUsd,
  getUserByMcpToken,
  logTransaction,
} from "../../lib/db.js";
import { authenticateToolCall } from "../../lib/tool-auth.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import { routePayment } from "../../lib/payments/router.js";
import { acquireIdempotencyKey } from "../../lib/idempotency.js";
import {
  registerSubscribeService,
  registerSubscribeServiceTool,
} from "../../tools/subscribe-service.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = {
  id: "user_sub_123",
  email: "t@t.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as any,
  vercel_token: "vercel_tok_abc",
  netlify_token: "nlf",
  railway_token: "rly",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd",
  modal_token: "modal_tok",
  huggingface_token: "hf",
  gamma_api_key: "g",
  cloudflare_token: "cf",
  cloudflare_account_id: "cfa",
  supabase_user_token: "sb",
  max_auto_charge_usd: 50,
};

const MOCK_SUBSCRIPTION = {
  id: "11111111-1111-1111-1111-111111111111",
  user_id: MOCK_USER.id,
  service: "vercel",
  amount_usd: 20,
  currency: "USD",
  interval: "monthly" as const,
  status: "active" as const,
  description: "Vercel Pro plan",
  started_at: "2026-05-13T00:00:00.000Z",
  next_charge_at: "2026-06-13T00:00:00.000Z",
  last_charged_at: null,
  cancelled_at: null,
  metadata: null,
  created_at: "2026-05-13T00:00:00.000Z",
  updated_at: "2026-05-13T00:00:00.000Z",
};

const NEW_INPUT = {
  service: "vercel",
  amount_usd: 20,
  interval: "monthly" as const,
  description: "Vercel Pro plan",
  mcp_token: "spx_test_token",
};

const LEGACY_INPUT = {
  service_name: "vercel",
  plan_name: "pro",
  amount_usd: 20,
  mcp_token: "spx_test_token",
};

// ---------------------------------------------------------------------------
// Handler capture — registered once for all tests
// ---------------------------------------------------------------------------

type Handler = (input: any) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let newHandler: Handler | undefined;
let legacyHandler: Handler | undefined;

const mockServer = { tool: vi.fn() };

beforeAll(() => {
  // The two registration functions each call `server.tool(name, ...)` exactly
  // once, so we route by tool name into the right handler slot.
  mockServer.tool.mockImplementation(
    (name: string, _desc: string, _schema: any, h: Handler) => {
      if (name === "subscribe_service") newHandler = h;
      else if (name === "subscribe_to_service") legacyHandler = h;
    }
  );
  registerSubscribeService(mockServer as any);
  registerSubscribeServiceTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mock state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(authenticateToolCall).mockReset();
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(getRulesForUser).mockReset();
  vi.mocked(getMonthlySpendUsd).mockReset();
  vi.mocked(createSubscription).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(acquireIdempotencyKey).mockReset();

  (config as any).emergencyStop = false;

  // Happy-path defaults — individual tests override what they need
  vi.mocked(authenticateToolCall).mockResolvedValue({
    ok: true,
    user: MOCK_USER as any,
  } as any);
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getRulesForUser).mockResolvedValue([]);
  vi.mocked(getMonthlySpendUsd).mockResolvedValue(0);
  vi.mocked(createSubscription).mockResolvedValue(MOCK_SUBSCRIPTION as any);
  vi.mocked(routePayment).mockResolvedValue({
    outcome: "charged",
    transactionId: "pi_mock_sub",
    paymentMethod: "stripe_card",
  } as any);
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
  vi.mocked(acquireIdempotencyKey).mockReturnValue(true);
});

// ===========================================================================
// New subscribe_service tool
// ===========================================================================

describe("registerSubscribeService — auth failure", () => {
  it("propagates the auth failure response without creating a subscription", async () => {
    vi.mocked(authenticateToolCall).mockResolvedValue({
      ok: false,
      response: {
        content: [{ type: "text", text: "Invalid or expired MCP token." }],
        isError: true,
      },
    } as any);

    const result = await newHandler!(NEW_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid or expired/);
    expect(vi.mocked(createSubscription)).not.toHaveBeenCalled();
  });
});

describe("registerSubscribeService — blocked service", () => {
  it("declines without creating a subscription when service is on blocked list", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r1",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: ["vercel"],
        per_service_monthly_cap_usd: null,
        per_service_per_tx_cap_usd: null,
        active: true,
      } as any,
    ]);

    const result = await newHandler!(NEW_INPUT);

    expect(result.content[0].text).toMatch(/blocked-services/i);
    expect(vi.mocked(createSubscription)).not.toHaveBeenCalled();
  });
});

describe("registerSubscribeService — amount exceeds per-tx cap", () => {
  it("declines when amount > user.max_auto_charge_usd", async () => {
    vi.mocked(authenticateToolCall).mockResolvedValue({
      ok: true,
      user: { ...MOCK_USER, max_auto_charge_usd: 10 },
    } as any);

    const result = await newHandler!({ ...NEW_INPUT, amount_usd: 20 });

    expect(result.content[0].text).toMatch(/per-transaction cap/i);
    expect(vi.mocked(createSubscription)).not.toHaveBeenCalled();
  });
});

describe("registerSubscribeService — monthly budget projection declines first renewal", () => {
  it("declines when month-to-date + amount > global monthly_budget_usd", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r1",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: 25,
        allowed_services: null,
        blocked_services: null,
        per_service_monthly_cap_usd: null,
        per_service_per_tx_cap_usd: null,
        active: true,
      } as any,
    ]);
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(10);

    const result = await newHandler!({ ...NEW_INPUT, amount_usd: 20 });

    expect(result.content[0].text).toMatch(/monthly budget/i);
    expect(vi.mocked(createSubscription)).not.toHaveBeenCalled();
  });
});

describe("registerSubscribeService — happy path", () => {
  it("creates a subscription and returns next_charge_at + subscription id", async () => {
    const result = await newHandler!(NEW_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toMatch(/SUBSCRIPTION CREATED/);
    expect(text).toContain(MOCK_SUBSCRIPTION.id);
    expect(text).toContain(MOCK_SUBSCRIPTION.next_charge_at);
    expect(text).toMatch(/cancel_subscription/);

    expect(vi.mocked(createSubscription)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "vercel",
        amountUsd: 20,
        interval: "monthly",
        description: "Vercel Pro plan",
      })
    );
  });

  it("audit-logs subscription_create with amountUsd=0 so it doesn't count toward monthly spend", async () => {
    await newHandler!(NEW_INPUT);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "vercel",
        status: "success",
        amountUsd: 0,
        transactionType: "subscription_create",
        agentId: MOCK_SUBSCRIPTION.id,
      })
    );
  });
});

describe("registerSubscribeService — createSubscription failure", () => {
  it("returns isError:true and does not log subscription_create when insert throws", async () => {
    vi.mocked(createSubscription).mockRejectedValue(new Error("PG connection refused"));

    const result = await newHandler!(NEW_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Could not create subscription/);
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalledWith(
      expect.objectContaining({ transactionType: "subscription_create" })
    );
  });
});

// ===========================================================================
// Legacy subscribe_to_service tool — kept for backwards compatibility
// ===========================================================================

describe("registerSubscribeServiceTool (legacy) — rate limit denied", () => {
  it("returns isError:true with retryAfterMs in message when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfterMs: 6000,
    });

    const result = await legacyHandler!(LEGACY_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many requests/);
    expect(result.content[0].text).toMatch(/6 second/);
  });
});

describe("registerSubscribeServiceTool (legacy) — emergency stop", () => {
  it("returns isError:true with maintenance message when emergencyStop is true", async () => {
    (config as any).emergencyStop = true;

    const result = await legacyHandler!(LEGACY_INPUT);

    (config as any).emergencyStop = false;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/maintenance/i);
  });
});

describe("registerSubscribeServiceTool (legacy) — invalid MCP token", () => {
  it("returns isError:true with 'Invalid or expired' when getUserByMcpToken returns null", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue(null as any);

    const result = await legacyHandler!(LEGACY_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid or expired/);
  });
});

describe("registerSubscribeServiceTool (legacy) — amount exceeds auto-approve limit", () => {
  it("returns an informational message (no isError) when amount_usd exceeds max_auto_charge_usd", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      max_auto_charge_usd: 10,
    } as any);

    const result = await legacyHandler!({ ...LEGACY_INPUT, amount_usd: 20 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/auto-approve limit/);
    expect(result.content[0].text).toMatch(/\$10/);
  });
});

describe("registerSubscribeServiceTool (legacy) — duplicate in-flight request", () => {
  it("returns isError:true when idempotency key is already held (in-flight)", async () => {
    vi.mocked(acquireIdempotencyKey).mockReturnValue(false);

    const result = await legacyHandler!(LEGACY_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already in progress/);
  });
});

describe("registerSubscribeServiceTool (legacy) — payment failure", () => {
  it("returns isError:true with 'Payment failed' and logs payment_failed when routePayment throws", async () => {
    vi.mocked(routePayment).mockRejectedValue(new Error("Card declined"));

    const result = await legacyHandler!(LEGACY_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Payment failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "payment_failed",
        transactionType: "subscription",
      })
    );
  });
});

describe("registerSubscribeServiceTool (legacy) — success", () => {
  it("returns confirmation with transaction ID and logs success with transactionType 'subscription'", async () => {
    const result = await legacyHandler!(LEGACY_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("pi_mock_sub");
    expect(text.toLowerCase()).toMatch(/vercel|pro/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        transactionType: "subscription",
        service: "vercel",
      })
    );
  });
});
