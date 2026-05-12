/**
 * Tests for per-service spending limits (use case V2 #5.2).
 *
 * Verifies the per-service caps wired through `getRulesForUser` are honored
 * by `pay_for_service`. The four scenarios required by the spec are covered:
 *
 *   1. per_service_per_tx_cap_usd exceeded  → decline names the service
 *   2. per_service_monthly_cap_usd exceeded → decline names the service
 *   3. caps NOT exceeded                    → approve
 *   4. no per-service rule at all           → falls back to global rules
 *
 * Mocks the same surface as pay-for-service.test.ts so the test file is
 * self-contained and runs offline.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must precede the imports of the modules under test.
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
// Imports — after mocks
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
import { retrieveCardDetails } from "../../lib/stripe-issuing.js";
import { acquireIdempotencyKey } from "../../lib/idempotency.js";
import { registerPayForServiceTool } from "../../tools/pay-for-service.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "a".repeat(32);

const MOCK_USER = {
  id: "user_caps",
  email: "alice@example.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as never,
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
  // Generous global cap so the per-service rule is the only thing that can
  // refuse the charge in these tests.
  max_auto_charge_usd: 1000,
};

const MOCK_CARD = {
  number: "4242424242424242",
  expMonth: 12,
  expYear: 2030,
  cvc: "123",
  brand: "Visa",
  last4: "4242",
};

const INPUT = {
  service: "vercel",
  amount_usd: 20,
  description: "Upgrade my-app to Vercel Pro plan",
  mcp_token: VALID_TOKEN,
};

// ---------------------------------------------------------------------------
// Handler capture
// ---------------------------------------------------------------------------

type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

let handler: ((input: Record<string, unknown>) => Promise<HandlerResult>) | undefined;

const mockServer = { tool: vi.fn() };

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (
      _name: string,
      _desc: string,
      _schema: unknown,
      h: (input: Record<string, unknown>) => Promise<HandlerResult>
    ) => {
      handler = h;
    }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPayForServiceTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(getRulesForUser).mockReset();
  vi.mocked(getMonthlySpendUsd).mockReset();
  vi.mocked(getActiveVirtualCardForUser).mockReset();
  vi.mocked(retrieveCardDetails).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(acquireIdempotencyKey).mockReset();
  vi.mocked(getOrCreateConsentPreferences).mockReset();
  vi.mocked(createConsentRequest).mockReset();
  vi.mocked(recordConsentDecision).mockReset();

  // Happy-path defaults.
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getMonthlySpendUsd).mockResolvedValue(0);
  vi.mocked(getActiveVirtualCardForUser).mockResolvedValue({
    stripe_card_id: "ic_test_caps",
  });
  vi.mocked(retrieveCardDetails).mockResolvedValue(MOCK_CARD);
  vi.mocked(logTransaction).mockResolvedValue(undefined);
  vi.mocked(acquireIdempotencyKey).mockReturnValue(true);
  // Bypass the inline-consent gate: the merchant under test is trusted.
  vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
    user_id: MOCK_USER.id,
    default_mode: "auto_for_trusted_services",
    auto_below_threshold_usd: null,
    trusted_services: ["vercel"],
    notification_channels: [],
    telegram_chat_id: null,
    email_for_consent: null,
  });
});

// ---------------------------------------------------------------------------
// 1. Per-service per-transaction cap exceeded → decline
// ---------------------------------------------------------------------------

describe("pay_for_service — per-service per-transaction cap", () => {
  it("declines when amount exceeds per_service_per_tx_cap_usd and names the service", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-ps-tx",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: null,
        per_service_monthly_cap_usd: null,
        per_service_per_tx_cap_usd: 10,
        active: true,
      },
    ]);

    const result = await handler!({ ...INPUT, amount_usd: 25 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/PAYMENT DECLINED/);
    // The decline message must clearly identify the service that blocked
    // the charge — this is the spec for use case V2 #5.2.
    expect(text).toMatch(/per-transaction cap for vercel/);
    expect(text).toMatch(/\$25\.00 attempted/);
    expect(text).toMatch(/\$10\.00 cap/);
    // Card details must not leak when the charge is declined.
    expect(text).not.toContain("4242");
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Per-service monthly cap exceeded → decline
// ---------------------------------------------------------------------------

describe("pay_for_service — per-service monthly cap", () => {
  it("declines when monthly spend + charge would exceed per_service_monthly_cap_usd", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-ps-month",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: null,
        per_service_monthly_cap_usd: 50,
        per_service_per_tx_cap_usd: null,
        active: true,
      },
    ]);
    // $45 already spent on vercel this month — adding $20 brings the total
    // to $65, which exceeds the $50 vercel cap.
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(45);

    const result = await handler!({ ...INPUT, amount_usd: 20 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/PAYMENT DECLINED/);
    // Decline must spell out the exact arithmetic so the agent can relay it
    // back to the user without re-computing anything.
    expect(text).toMatch(/monthly cap for vercel/);
    expect(text).toMatch(/\$45\.00 spent/);
    expect(text).toMatch(/\$50\.00 cap/);
    expect(text).toMatch(/this charge \$20\.00/);
    expect(text).toMatch(/would bring to \$65\.00/);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();

    // Spend lookup must have been scoped to the merchant, not the user's
    // total spend across every service.
    expect(vi.mocked(getMonthlySpendUsd)).toHaveBeenCalledWith(MOCK_USER.id, "vercel");
  });
});

// ---------------------------------------------------------------------------
// 3. Per-service caps NOT exceeded → approve
// ---------------------------------------------------------------------------

describe("pay_for_service — per-service caps within limits", () => {
  it("approves the charge when both per-service caps leave room", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-ps-ok",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: null,
        // $50 monthly + $30 per-tx, and only $10 already spent.
        per_service_monthly_cap_usd: 50,
        per_service_per_tx_cap_usd: 30,
        active: true,
      },
    ]);
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(10);

    // $20 charge: under the $30 per-tx, and 10+20=30 stays under the $50 cap.
    const result = await handler!({ ...INPUT, amount_usd: 20 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/^APPROVED/);
    expect(text).toContain("4242 4242 4242 4242");
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "vercel",
        status: "success",
        amountUsd: 20,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// 4. No per-service rule → falls back to global rules
// ---------------------------------------------------------------------------

describe("pay_for_service — no per-service rule, fallback to global", () => {
  it("approves when there is no per-service rule and global rules leave room", async () => {
    // No per-service caps at all — both fields null. Global monthly budget
    // of $1000 with $5 already spent: easily room for a $20 charge.
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-global-only",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: 1000,
        allowed_services: null,
        blocked_services: null,
        per_service_monthly_cap_usd: null,
        per_service_per_tx_cap_usd: null,
        active: true,
      },
    ]);
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(5);

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^APPROVED/);
  });

  it("declines via the global monthly budget when no per-service rule exists", async () => {
    // No per-service cap. Global monthly cap of $50 with $40 spent: a $20
    // charge would push the total to $60 → declined by the GLOBAL rule
    // (not the per-service path), which proves the fallback works.
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-global-only-tight",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: 50,
        allowed_services: null,
        blocked_services: null,
        per_service_monthly_cap_usd: null,
        per_service_per_tx_cap_usd: null,
        active: true,
      },
    ]);
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(40);

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    // Message comes from the global monthly-budget branch, not the
    // per-service branch — "monthly budget" wording, not "monthly cap for".
    expect(text).toMatch(/monthly budget/);
    expect(text).not.toMatch(/monthly cap for vercel/);
  });
});
