/**
 * Tests for src/tools/pay-for-service.ts — registerPayForServiceTool
 *
 * Every I/O dependency is mocked (DB, rate-limit, Stripe Issuing reveal)
 * so the tests run completely offline and never touch real Stripe/Supabase.
 *
 * The MCP server is faked with a minimal { tool } stub that captures the
 * handler so we can drive it directly and assert on its return value.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must precede any import of the modules under test.
// vi.mock is hoisted to the top of the file by Vitest, so the order of these
// blocks vs. the imports below is irrelevant at runtime.
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
  // DEV_MODE is read once at module load — individual tests that need DEV
  // behavior import a separate test file or use vi.resetModules to flip it.
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
import { acquireIdempotencyKey } from "../../lib/idempotency.js";
import { registerPayForServiceTool } from "../../tools/pay-for-service.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "a".repeat(32);

const MOCK_USER = {
  id: "user_pfs",
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

const INPUT = {
  service: "vercel",
  amount_usd: 20,
  description: "Upgrade to Pro plan",
  mcp_token: VALID_TOKEN,
};

// ---------------------------------------------------------------------------
// Handler capture — register once for all tests
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
    stripe_card_id: "ic_test_123",
  });
  vi.mocked(retrieveCardDetails).mockResolvedValue(MOCK_CARD);
  vi.mocked(logTransaction).mockResolvedValue(undefined);
  vi.mocked(acquireIdempotencyKey).mockReturnValue(true);
  // Default consent preferences: trust the service used in the shared
  // INPUT fixture so the existing tests bypass the inline-consent gate.
  // The dedicated pay-for-service-elicit.test.ts file exercises the
  // always_ask / decline / fallback branches.
  vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
    user_id: MOCK_USER.id,
    default_mode: "auto_for_trusted_services",
    auto_below_threshold_usd: null,
    trusted_services: ["vercel"],
    notification_channels: [],
    telegram_chat_id: null,
    email_for_consent: null,
  });
  vi.mocked(createConsentRequest).mockResolvedValue({
    id: "consent_default",
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

// ---------------------------------------------------------------------------
// DEV mode — note: DEV_MODE is read at module load above, so to exercise the
// dev branch we re-import the tool with the mock overridden via resetModules.
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — DEV mode", () => {
  it("returns a simulated card-reveal response without touching DB or Stripe", async () => {
    vi.resetModules();

    vi.doMock("../../config.js", () => ({
      config: { emergencyStop: false },
      DEV_MODE: true,
    }));

    // These mocks must stay in place after resetModules so the dynamically
    // imported tool sees the same stubs.
    vi.doMock("../../lib/db.js", () => ({
      getUserByMcpToken: vi.fn(),
      getRulesForUser: vi.fn(),
      getMonthlySpendUsd: vi.fn(),
      getActiveVirtualCardForUser: vi.fn(),
      logTransaction: vi.fn(),
      getOrCreateConsentPreferences: vi.fn(),
      createConsentRequest: vi.fn(),
      recordConsentDecision: vi.fn(),
    }));
    vi.doMock("../../lib/rate-limit.js", () => ({
      checkRateLimit: vi.fn(),
    }));
    vi.doMock("../../lib/stripe-issuing.js", () => ({
      retrieveCardDetails: vi.fn(),
    }));
    vi.doMock("../../lib/idempotency.js", () => ({
      acquireIdempotencyKey: vi.fn(),
      releaseIdempotencyKey: vi.fn(),
    }));

    const { registerPayForServiceTool: devRegister } = await import(
      "../../tools/pay-for-service.js"
    );

    let devHandler:
      | ((input: Record<string, unknown>) => Promise<HandlerResult>)
      | undefined;
    const devServer = {
      tool: (
        _n: string,
        _d: string,
        _s: unknown,
        h: (input: Record<string, unknown>) => Promise<HandlerResult>
      ) => {
        devHandler = h;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    devRegister(devServer as any);

    const result = await devHandler!(INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/DEV MODE/);
    // Masked but realistic-looking card number (last4 visible).
    expect(text).toContain("•••• •••• •••• 4242");
    expect(text).toContain("vercel");

    vi.resetModules();
    vi.doUnmock("../../config.js");
    vi.doUnmock("../../lib/db.js");
    vi.doUnmock("../../lib/rate-limit.js");
    vi.doUnmock("../../lib/stripe-issuing.js");
    vi.doUnmock("../../lib/idempotency.js");
  });
});

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — rate limit", () => {
  it("blocks the request with isError when checkRateLimit returns allowed=false", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfterMs: 8000,
    });

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Too many requests/);
    expect(result.content[0]!.text).toMatch(/8 second/);
    // Must not have hit the DB at all.
    expect(vi.mocked(getUserByMcpToken)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token format validation
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — invalid MCP token format", () => {
  it("rejects malformed tokens with isError before any DB lookup", async () => {
    const result = await handler!({ ...INPUT, mcp_token: "not-a-real-token" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid MCP token format/);
    expect(vi.mocked(getUserByMcpToken)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Missing user
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — unknown user", () => {
  it("declines when getUserByMcpToken returns null", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getUserByMcpToken).mockResolvedValue(null as any);

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid or expired MCP token/);
    expect(vi.mocked(getActiveVirtualCardForUser)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-transaction cap
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — per-transaction cap exceeded", () => {
  it("declines and explains why when amount exceeds max_auto_charge_usd", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      max_auto_charge_usd: 10,
    } as any);

    const result = await handler!({ ...INPUT, amount_usd: 25 });

    // Rule-driven decline — informational, not an infrastructure error.
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/PAYMENT DECLINED/);
    expect(text).toMatch(/per-transaction cap of \$10\.00/);
    expect(text).toMatch(/Your agent should:/);
    // Must not reveal card details when declined.
    expect(text).not.toMatch(/4242/);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });

  it("declines when a rule sets a tighter per-transaction cap than max_auto_charge_usd", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r1",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: 5,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);

    const result = await handler!({ ...INPUT, amount_usd: 8 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/per-transaction cap of \$5\.00/);
  });
});

// ---------------------------------------------------------------------------
// Monthly budget
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — monthly budget exceeded", () => {
  it("declines when this charge would push monthly spend over the budget", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-month",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: 50,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(45);

    const result = await handler!({ ...INPUT, amount_usd: 10 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/monthly budget/);
    expect(text).toMatch(/\$50\.00/);
    expect(text).toMatch(/already spent: \$45\.00/);
    // Card must not be revealed when the budget rule blocks the charge.
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Blocked / allowed merchants
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — blocked merchants", () => {
  it("declines when the service is on the user's blocked_services list", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-block",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: ["vercel"],
        active: true,
      },
    ]);

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/blocked-services list/);
  });

  it("declines when the service is not on a non-empty allowed_services list", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r-allow",
        user_id: MOCK_USER.id,
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: null,
        allowed_services: ["modal", "openai"],
        blocked_services: null,
        active: true,
      },
    ]);

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/allowed-services list/);
  });
});

// ---------------------------------------------------------------------------
// Card reveal — happy path
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — card reveal happy path", () => {
  it("returns APPROVED with formatted card details and writes audit log", async () => {
    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;

    expect(text).toMatch(/^APPROVED/);
    expect(text).toContain("vercel");
    // PAN must be formatted with spaces.
    expect(text).toContain("4242 4242 4242 4242");
    expect(text).toContain("CVC: 123");
    // Two-digit year and zero-padded month.
    expect(text).toContain("Expiry: 12/30");
    expect(text).toMatch(/limit of \$100\.00 per transaction/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "vercel",
        status: "success",
        amountUsd: 20,
        description: "Upgrade to Pro plan",
        transactionType: "one_shot",
      })
    );
  });

  it("returns isError with the card-not-found decline when no virtual card is on file", async () => {
    vi.mocked(getActiveVirtualCardForUser).mockResolvedValue(null);

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no active virtual card/);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Native API preference — no integration exists yet
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — explicit native_api preference", () => {
  it("declines cleanly when the user asks for native_api but no integration exists", async () => {
    const result = await handler!({
      ...INPUT,
      payment_method: "native_api",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/no native API integration/);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Duplicate in-flight
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — duplicate in-flight request", () => {
  it("rejects when the same (user, service, amount) is already in flight", async () => {
    vi.mocked(acquireIdempotencyKey).mockReturnValue(false);

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/already in progress/);
  });
});
