/**
 * Tests for the smart-rules path in src/tools/pay-for-service.ts.
 *
 * Verifies that the LLM-classified intent is wired through the rules
 * evaluator and that the four new rule_types each block / allow the
 * charge under the expected conditions:
 *
 *   - category_blocklist          → decline naming the category
 *   - risk_threshold              → decline naming the score
 *   - urgency_requires_consent    → decline asking for explicit consent
 *   - category_max_per_month      → decline with per-category spend total
 *
 * Plus the audit log: every successful charge writes the classification
 * into `audit_logs.intent_metadata` regardless of whether smart rules
 * are configured — the dataset is collected unconditionally.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  getRulesForUser: vi.fn(),
  getMonthlySpendUsd: vi.fn(),
  getMonthlyCategorySpendUsd: vi.fn(),
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

vi.mock("../../lib/intent-classifier.js", () => ({
  classifyIntent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  getUserByMcpToken,
  getRulesForUser,
  getMonthlySpendUsd,
  getMonthlyCategorySpendUsd,
  getActiveVirtualCardForUser,
  logTransaction,
  getOrCreateConsentPreferences,
  createConsentRequest,
  recordConsentDecision,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { retrieveCardDetails } from "../../lib/stripe-issuing.js";
import { acquireIdempotencyKey } from "../../lib/idempotency.js";
import { classifyIntent } from "../../lib/intent-classifier.js";
import { registerPayForServiceTool } from "../../tools/pay-for-service.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "a".repeat(32);

const MOCK_USER = {
  id: "user_smart",
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
  // Generous static cap so only smart rules can decline the test cases.
  max_auto_charge_usd: 10_000,
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
  service: "draftkings",
  amount_usd: 50,
  description: "weekly fantasy entry",
  mcp_token: VALID_TOKEN,
};

// Convenience: shape that satisfies the SpendexRule contract.
function makeRule(overrides: Record<string, unknown>) {
  return {
    id: "r1",
    user_id: MOCK_USER.id,
    service_filter: null,
    max_per_transaction_usd: null,
    monthly_budget_usd: null,
    allowed_services: null,
    blocked_services: null,
    per_service_monthly_cap_usd: null,
    per_service_per_tx_cap_usd: null,
    active: true,
    ...overrides,
  };
}

const GAMBLING_CLASSIFICATION = {
  category: "gambling",
  subcategory: "sports_betting",
  urgency: "low" as const,
  risk_score: 85,
  reasoning: "fantasy sports entry",
  source: "llm" as const,
  model: "claude-haiku-4-5-20251001",
};

const DEV_TOOLS_CLASSIFICATION = {
  category: "dev_tools",
  subcategory: "cloud_compute",
  urgency: "medium" as const,
  risk_score: 5,
  reasoning: "standard cloud upgrade",
  source: "llm" as const,
  model: "claude-haiku-4-5-20251001",
};

const HIGH_URGENCY_CLASSIFICATION = {
  category: "shopping",
  subcategory: "electronics",
  urgency: "high" as const,
  risk_score: 40,
  reasoning: "urgent purchase",
  source: "llm" as const,
  model: "claude-haiku-4-5-20251001",
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
  vi.mocked(getMonthlyCategorySpendUsd).mockReset();
  vi.mocked(getActiveVirtualCardForUser).mockReset();
  vi.mocked(retrieveCardDetails).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(acquireIdempotencyKey).mockReset();
  vi.mocked(getOrCreateConsentPreferences).mockReset();
  vi.mocked(createConsentRequest).mockReset();
  vi.mocked(recordConsentDecision).mockReset();
  vi.mocked(classifyIntent).mockReset();

  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getMonthlySpendUsd).mockResolvedValue(0);
  vi.mocked(getMonthlyCategorySpendUsd).mockResolvedValue(0);
  vi.mocked(getActiveVirtualCardForUser).mockResolvedValue({
    stripe_card_id: "ic_test_123",
  });
  vi.mocked(retrieveCardDetails).mockResolvedValue(MOCK_CARD);
  vi.mocked(logTransaction).mockResolvedValue(undefined);
  vi.mocked(acquireIdempotencyKey).mockReturnValue(true);
  vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
    user_id: MOCK_USER.id,
    default_mode: "auto_for_trusted_services",
    auto_below_threshold_usd: null,
    // Trust every service used in this suite so the consent gate doesn't
    // interfere with the smart-rule assertions.
    trusted_services: ["draftkings", "vercel", "amazon"],
    notification_channels: [],
    telegram_chat_id: null,
    email_for_consent: null,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// category_blocklist
// ---------------------------------------------------------------------------

describe("smart rules — category_blocklist", () => {
  it("declines when the classified category is on the user's blocklist", async () => {
    vi.mocked(classifyIntent).mockResolvedValueOnce(GAMBLING_CLASSIFICATION);
    vi.mocked(getRulesForUser).mockResolvedValue([
      makeRule({ category_blocklist: ["gambling", "crypto"] }),
    ]);

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/PAYMENT DECLINED/);
    expect(text).toMatch(/gambling/);
    expect(text).toMatch(/blocked-categories list/);
    // Card must not be revealed when blocked.
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });

  it("approves when the category is NOT on the blocklist", async () => {
    vi.mocked(classifyIntent).mockResolvedValueOnce(DEV_TOOLS_CLASSIFICATION);
    vi.mocked(getRulesForUser).mockResolvedValue([
      makeRule({ category_blocklist: ["gambling"] }),
    ]);

    const result = await handler!({
      ...BASE_INPUT,
      service: "vercel",
      amount_usd: 20,
      description: "upgrade to pro",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/APPROVED/);
  });
});

// ---------------------------------------------------------------------------
// risk_threshold
// ---------------------------------------------------------------------------

describe("smart rules — risk_threshold", () => {
  it("declines when classification.risk_score > rule.risk_threshold", async () => {
    vi.mocked(classifyIntent).mockResolvedValueOnce({
      ...DEV_TOOLS_CLASSIFICATION,
      risk_score: 90,
    });
    vi.mocked(getRulesForUser).mockResolvedValue([
      makeRule({ risk_threshold: 50 }),
    ]);

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/AI risk score of 90/);
    expect(text).toMatch(/threshold of 50/);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });

  it("approves when risk_score <= risk_threshold", async () => {
    vi.mocked(classifyIntent).mockResolvedValueOnce({
      ...DEV_TOOLS_CLASSIFICATION,
      risk_score: 30,
    });
    vi.mocked(getRulesForUser).mockResolvedValue([
      makeRule({ risk_threshold: 50 }),
    ]);

    const result = await handler!(BASE_INPUT);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/APPROVED/);
  });
});

// ---------------------------------------------------------------------------
// urgency_requires_consent
// ---------------------------------------------------------------------------

describe("smart rules — urgency_requires_consent", () => {
  it("declines with a consent directive when urgency=high and the rule is set", async () => {
    vi.mocked(classifyIntent).mockResolvedValueOnce(HIGH_URGENCY_CLASSIFICATION);
    vi.mocked(getRulesForUser).mockResolvedValue([
      makeRule({ urgency_requires_consent: true }),
    ]);

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/high-urgency/);
    expect(text).toMatch(/request_user_consent/);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });

  it("approves when urgency=medium even if the rule is set", async () => {
    vi.mocked(classifyIntent).mockResolvedValueOnce({
      ...HIGH_URGENCY_CLASSIFICATION,
      urgency: "medium",
    });
    vi.mocked(getRulesForUser).mockResolvedValue([
      makeRule({ urgency_requires_consent: true }),
    ]);

    const result = await handler!(BASE_INPUT);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/APPROVED/);
  });
});

// ---------------------------------------------------------------------------
// category_max_per_month
// ---------------------------------------------------------------------------

describe("smart rules — category_max_per_month", () => {
  it("declines when the category cap would be exceeded", async () => {
    vi.mocked(classifyIntent).mockResolvedValueOnce({
      ...DEV_TOOLS_CLASSIFICATION,
      category: "shopping",
    });
    vi.mocked(getRulesForUser).mockResolvedValue([
      makeRule({ category_caps: { shopping: 100 } }),
    ]);
    // Already spent $80 on shopping this month → +$50 would bust the $100 cap.
    vi.mocked(getMonthlyCategorySpendUsd).mockResolvedValue(80);

    const result = await handler!({ ...BASE_INPUT, amount_usd: 50 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/monthly cap for category "shopping"/);
    expect(text).toMatch(/\$80\.00 spent/);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });

  it("does not query category spend when no category cap is configured", async () => {
    vi.mocked(classifyIntent).mockResolvedValueOnce(DEV_TOOLS_CLASSIFICATION);
    vi.mocked(getRulesForUser).mockResolvedValue([makeRule({})]);

    await handler!({ ...BASE_INPUT, service: "vercel", amount_usd: 20 });

    expect(vi.mocked(getMonthlyCategorySpendUsd)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// audit_logs.intent_metadata
// ---------------------------------------------------------------------------

describe("smart rules — audit log intent_metadata", () => {
  it("populates intent_metadata on the success audit log row", async () => {
    vi.mocked(classifyIntent).mockResolvedValueOnce(DEV_TOOLS_CLASSIFICATION);
    vi.mocked(getRulesForUser).mockResolvedValue([]);

    const result = await handler!({ ...BASE_INPUT, service: "vercel", amount_usd: 20 });

    expect(result.isError).toBeUndefined();
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        intentMetadata: expect.objectContaining({
          category: "dev_tools",
          subcategory: "cloud_compute",
          urgency: "medium",
          risk_score: 5,
        }),
      })
    );
  });
});
