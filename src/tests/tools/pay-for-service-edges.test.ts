/**
 * Edge-case tests for src/tools/pay-for-service.ts — registerPayForServiceTool
 *
 * These cover the inputs and rule combinations that the primary
 * pay-for-service.test.ts suite doesn't exercise:
 *
 *   1.  amount_usd = 0 (schema rejection)
 *   2.  amount_usd = 0.001 (sub-cent — accepted, formatted to $0.00)
 *   3.  amount_usd = Number.MAX_SAFE_INTEGER (declined by per-tx cap)
 *   4.  service = "" (schema rejection)
 *   5.  service with Unicode characters (passes through, lowercased for compare)
 *   6.  description with 10 000 characters (accepted, logged verbatim)
 *   7.  Concurrent calls collapsing on the in-flight idempotency key
 *   8.  max_auto_charge_usd = 0 + active allowed_services rule (interaction)
 *   9.  Monthly budget exactly equal to spent + amount (boundary — should pass)
 *   10. Stripe card revoked (retrieveCardDetails throws) — clean error
 *
 * Same mocking strategy as pay-for-service.test.ts: every I/O dependency is
 * stubbed, the MCP server is faked with a `{ tool }` capture, and the handler
 * is driven directly. Schema-rejection cases (1, 4) build a real Zod object
 * from the captured shape and assert that `.safeParse` rejects the input.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mocks — must precede any import of the modules under test.
// ---------------------------------------------------------------------------

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  getRulesForUser: vi.fn(),
  getMonthlySpendUsd: vi.fn(),
  getActiveVirtualCardForUser: vi.fn(),
  logTransaction: vi.fn(),
  getOrCreateConsentPreferences: vi.fn(),
  createConsentRequest: vi.fn(),
  recordConsentDecision: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("../../config.js", () => {
  const cfg = { emergencyStop: false };
  return { config: cfg, DEV_MODE: false };
});

vi.mock("../../lib/stripe-issuing.js", () => ({
  retrieveCardDetails: vi.fn(),
}));

vi.mock("../../lib/idempotency.js", () => ({
  acquireIdempotencyKey: vi.fn(),
  releaseIdempotencyKey: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after the mocks
// ---------------------------------------------------------------------------

import {
  getUserByMcpToken,
  getRulesForUser,
  getMonthlySpendUsd,
  getActiveVirtualCardForUser,
  logTransaction,
  getOrCreateConsentPreferences,
  createConsentRequest,
  recordConsentDecision,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import { retrieveCardDetails } from "../../lib/stripe-issuing.js";
import {
  acquireIdempotencyKey,
  releaseIdempotencyKey,
} from "../../lib/idempotency.js";
import { registerPayForServiceTool } from "../../tools/pay-for-service.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "b".repeat(32);

const MOCK_USER = {
  id: "user_edges",
  email: "edge@example.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_edge" as never,
  vercel_token: "v",
  netlify_token: "nlf",
  railway_token: "rly",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd",
  modal_token: "mod",
  huggingface_token: "hf",
  gamma_api_key: "gk",
  cloudflare_token: "cf",
  cloudflare_account_id: "cfacc",
  supabase_user_token: "sb",
  max_auto_charge_usd: 100,
};

const MOCK_CARD = {
  number: "4242424242424242",
  expMonth: 12,
  expYear: 2030,
  cvc: "123",
  brand: "Visa",
  last4: "4242",
};

const BASE_INPUT = {
  service: "vercel",
  amount_usd: 20,
  description: "Edge-case base description",
  mcp_token: VALID_TOKEN,
};

// ---------------------------------------------------------------------------
// Handler + schema capture — register once for all tests
// ---------------------------------------------------------------------------

type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

let handler:
  | ((input: Record<string, unknown>) => Promise<HandlerResult>)
  | undefined;

// The raw Zod shape that the tool registers. We rebuild it into a z.object
// so we can run safeParse() in schema-rejection tests.
let capturedShape: z.ZodRawShape | undefined;

const mockServer = { tool: vi.fn() };

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (
      _name: string,
      _desc: string,
      schema: z.ZodRawShape,
      h: (input: Record<string, unknown>) => Promise<HandlerResult>
    ) => {
      capturedShape = schema;
      handler = h;
    }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPayForServiceTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(getRulesForUser).mockReset();
  vi.mocked(getMonthlySpendUsd).mockReset();
  vi.mocked(getActiveVirtualCardForUser).mockReset();
  vi.mocked(retrieveCardDetails).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(acquireIdempotencyKey).mockReset();
  vi.mocked(releaseIdempotencyKey).mockReset();
  vi.mocked(getOrCreateConsentPreferences).mockReset();
  vi.mocked(createConsentRequest).mockReset();
  vi.mocked(recordConsentDecision).mockReset();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config as any).emergencyStop = false;

  // Happy-path defaults — overridden per-test as needed
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getRulesForUser).mockResolvedValue([]);
  vi.mocked(getMonthlySpendUsd).mockResolvedValue(0);
  vi.mocked(getActiveVirtualCardForUser).mockResolvedValue({
    stripe_card_id: "ic_edge_123",
  });
  vi.mocked(retrieveCardDetails).mockResolvedValue(MOCK_CARD);
  vi.mocked(logTransaction).mockResolvedValue(undefined);
  vi.mocked(acquireIdempotencyKey).mockReturnValue(true);
  vi.mocked(releaseIdempotencyKey).mockReturnValue(undefined);
  // Default consent preferences: auto-approve any reasonable amount so the
  // edge-case suite stays focused on rule/idempotency/Stripe surfaces
  // rather than the inline-consent gate. A handful of edge cases use
  // unicode-service / non-vercel service names, so we use the threshold
  // policy (service-agnostic) rather than the trusted-services list.
  vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
    user_id: MOCK_USER.id,
    default_mode: "auto_below_threshold",
    auto_below_threshold_usd: Number.MAX_SAFE_INTEGER,
    trusted_services: [],
    notification_channels: [],
    telegram_chat_id: null,
    email_for_consent: null,
  });
  vi.mocked(createConsentRequest).mockResolvedValue({
    id: "consent_edges",
    user_id: MOCK_USER.id,
    action: "pay_for_service",
    service: "vercel",
    amount_usd: 20,
    context: null,
    options: ["approve", "decline"],
    status: "pending",
    decision: null,
    decision_metadata: null,
    decision_made_at: null,
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    created_at: new Date().toISOString(),
  });
  vi.mocked(recordConsentDecision).mockResolvedValue(null);
});

// Helper — rebuild the input schema as a z.object() for safeParse().
function getInputSchema(): z.ZodObject<z.ZodRawShape> {
  if (!capturedShape) {
    throw new Error(
      "Input schema was not captured. registerPayForServiceTool must run in beforeAll."
    );
  }
  return z.object(capturedShape);
}

// ---------------------------------------------------------------------------
// 1. amount_usd = 0 (gratuit)
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — amount_usd = 0", () => {
  it("is rejected by the Zod schema (.positive()) before reaching the handler", () => {
    const schema = getInputSchema();
    const parsed = schema.safeParse({ ...BASE_INPUT, amount_usd: 0 });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The failing issue must point at amount_usd.
      const issue = parsed.error.issues.find((i) => i.path[0] === "amount_usd");
      expect(issue).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. amount_usd = 0.001 (sub-cent)
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — sub-cent amount (0.001)", () => {
  it("passes schema validation since 0.001 is positive", () => {
    const schema = getInputSchema();
    const parsed = schema.safeParse({ ...BASE_INPUT, amount_usd: 0.001 });
    expect(parsed.success).toBe(true);
  });

  it("proceeds to card reveal and logs the exact (un-rounded) amount", async () => {
    const result = await handler!({ ...BASE_INPUT, amount_usd: 0.001 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^APPROVED/);

    // logTransaction stores the raw amount — we deliberately keep precision
    // here so dashboards/reconciliation can detect sub-cent charges.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        amountUsd: 0.001,
        service: "vercel",
        status: "success",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// 3. amount_usd = Number.MAX_SAFE_INTEGER
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — Number.MAX_SAFE_INTEGER", () => {
  it("is declined by the per-transaction cap and never reveals the card", async () => {
    const result = await handler!({
      ...BASE_INPUT,
      amount_usd: Number.MAX_SAFE_INTEGER,
    });

    // Rule-driven decline — informational text, no isError flag.
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/PAYMENT DECLINED/);
    expect(text).toMatch(/per-transaction cap of \$100\.00/);

    // Card details must not leak when declined.
    expect(text).not.toMatch(/4242/);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. service = "" (empty string)
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — empty service string", () => {
  it("is rejected by the Zod schema (.min(1)) before reaching the handler", () => {
    const schema = getInputSchema();
    const parsed = schema.safeParse({ ...BASE_INPUT, service: "" });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "service");
      expect(issue).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. service with Unicode characters
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — Unicode service name", () => {
  it("passes schema validation and reaches the card-reveal path", async () => {
    const unicodeService = "réseau-社-🚀";
    const schema = getInputSchema();
    expect(
      schema.safeParse({ ...BASE_INPUT, service: unicodeService }).success
    ).toBe(true);

    const result = await handler!({ ...BASE_INPUT, service: unicodeService });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/^APPROVED/);
    // The service name is echoed verbatim into the response.
    expect(text).toContain(unicodeService);

    // And logged verbatim — important for reconciliation against the merchant
    // name on the Stripe Issuing authorization.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ service: unicodeService })
    );
  });

  it("matches a blocked_services entry case-insensitively when both sides differ in case", async () => {
    // Cyrillic example: rules list "ВЕРСЕЛЬ" (upper), agent sends lower-case.
    // The implementation lowercases both sides before comparing.
    const upper = "ВЕРСЕЛЬ";
    const lower = "версель";

    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-unicode-block",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: [upper],
        active: true,
      },
    ]);

    const result = await handler!({ ...BASE_INPUT, service: lower });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/blocked-services list/);
  });
});

// ---------------------------------------------------------------------------
// 6. Very long description (10 000 chars)
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — 10 000-char description", () => {
  it("accepts the long description, returns APPROVED, and logs it verbatim", async () => {
    const huge = "x".repeat(10_000);

    const schema = getInputSchema();
    expect(
      schema.safeParse({ ...BASE_INPUT, description: huge }).success
    ).toBe(true);

    const result = await handler!({ ...BASE_INPUT, description: huge });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^APPROVED/);

    // No truncation — the audit log carries the full string. If we ever start
    // truncating, this test will fail loudly so we can update both ends.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ description: huge })
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Concurrent calls with same idempotency context
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — concurrent calls, same idempotency context", () => {
  it("lets exactly one concurrent call through and rejects the others", async () => {
    // Simulate a real in-memory key store: first acquirer wins, every other
    // attempt sees the key as held.
    let acquired = false;
    vi.mocked(acquireIdempotencyKey).mockImplementation(() => {
      if (acquired) return false;
      acquired = true;
      return true;
    });
    vi.mocked(releaseIdempotencyKey).mockImplementation(() => {
      acquired = false;
    });

    // Hold the card reveal mid-flight until we release it. This guarantees all
    // five calls overlap in time — the winner is stuck inside the try/finally
    // when the other four call acquireIdempotencyKey.
    let releaseCardReveal: () => void = () => {};
    const cardRevealGate = new Promise<typeof MOCK_CARD>((resolve) => {
      releaseCardReveal = () => resolve(MOCK_CARD);
    });
    vi.mocked(retrieveCardDetails).mockReturnValue(cardRevealGate);

    const N = 5;
    const inFlight: Promise<HandlerResult>[] = [];
    for (let i = 0; i < N; i++) inFlight.push(handler!(BASE_INPUT));

    // Yield once so the winner reaches retrieveCardDetails and the other
    // four reach acquireIdempotencyKey → returns false → early return.
    await Promise.resolve();
    await Promise.resolve();

    // Now release the winner.
    releaseCardReveal();

    const results = await Promise.all(inFlight);

    const approved = results.filter(
      (r) => !r.isError && r.content[0]!.text.startsWith("APPROVED")
    );
    const rejected = results.filter(
      (r) => r.isError && /already in progress/.test(r.content[0]!.text)
    );

    expect(approved.length).toBe(1);
    expect(rejected.length).toBe(N - 1);

    // Exactly one charge logged — no double-billing.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledTimes(1);
    // Card revealed exactly once.
    expect(vi.mocked(retrieveCardDetails)).toHaveBeenCalledTimes(1);
    // Lock released by the winner so legitimate retries can succeed later.
    expect(vi.mocked(releaseIdempotencyKey)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 8. max_auto_charge_usd = 0 + allowed_services rule
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — max_auto_charge_usd = 0 with allowed_services rule", () => {
  it("treats max_auto_charge_usd = 0 as 'no per-tx cap configured' and lets the allow-list decide", async () => {
    // User has no auto-charge cap configured (0 = no threshold per the docs)
    // and an allow-list rule that does NOT include "vercel".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      max_auto_charge_usd: 0,
    } as any);
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-allow-only",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: null,
        allowed_services: ["modal", "openai"],
        blocked_services: null,
        active: true,
      },
    ]);

    const result = await handler!(BASE_INPUT);

    // Decline must be merchant-driven, not amount-driven. The text mentions
    // the allow-list, NOT a per-transaction cap.
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/allowed-services list/);
    expect(text).not.toMatch(/per-transaction cap/);
  });

  it("approves when max_auto_charge_usd = 0 and the service IS on the allow-list (no cap applied)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      max_auto_charge_usd: 0,
    } as any);
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-allow-yes",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: null,
        allowed_services: ["vercel"],
        blocked_services: null,
        active: true,
      },
    ]);

    // Even a large amount goes through because no per-tx cap is configured
    // (user cap = 0 → skipped; no rule cap either).
    const result = await handler!({ ...BASE_INPUT, amount_usd: 9_999 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^APPROVED/);

    // The reveal text reports the txLimit it falls back to (the requested
    // amount, since user.max_auto_charge_usd = 0).
    expect(result.content[0]!.text).toMatch(
      /limit of \$9999\.00 per transaction/
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Monthly budget exactly equal to spent + amount (boundary)
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — monthly budget boundary", () => {
  it("approves when spent + amount EXACTLY equals the budget (strict-greater check)", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-month-eq",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: 50,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);
    // 30 already spent + 20 charge = 50 = budget. Strict `>` → still allowed.
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(30);

    const result = await handler!({ ...BASE_INPUT, amount_usd: 20 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^APPROVED/);
  });

  it("declines when spent + amount exceeds the budget by even one cent", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-month-over",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: 50,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(30);

    // 30 + 20.01 = 50.01 > 50 → declined.
    const result = await handler!({ ...BASE_INPUT, amount_usd: 20.01 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/monthly budget/);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10. Stripe card revoked — cardholder exists, card retrieval fails
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — Stripe card revoked", () => {
  it("surfaces a clean error (isError=true) when retrieveCardDetails throws", async () => {
    // getActiveVirtualCardForUser returns a row (cardholder/record exists in
    // our DB), but Stripe rejects the reveal because the card was revoked.
    vi.mocked(getActiveVirtualCardForUser).mockResolvedValue({
      stripe_card_id: "ic_revoked_999",
    });
    vi.mocked(retrieveCardDetails).mockRejectedValue(
      new Error(
        "Failed to retrieve card details from Stripe: This card has been canceled."
      )
    );

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toMatch(/PAYMENT DECLINED/);
    expect(text).toMatch(/card details could not be retrieved/);
    // Underlying Stripe error message is surfaced (so support can act).
    expect(text).toMatch(/canceled/);
    // PAN is obviously NOT in the response.
    expect(text).not.toMatch(/4242/);
    // No audit log written — the charge never reached "success".
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
    // Idempotency key is released so a retry after the user replaces the card
    // is not stuck waiting on the 30s stale-window.
    expect(vi.mocked(releaseIdempotencyKey)).toHaveBeenCalledTimes(1);
  });
});
