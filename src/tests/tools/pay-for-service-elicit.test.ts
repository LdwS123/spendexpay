/**
 * Tests for the MCP-elicitation flow in src/tools/pay-for-service.ts.
 *
 * These cover the three branches added by the inline-consent refactor:
 *
 *   1. `always_ask` + elicit accepted (decision="approve") → charge proceeds,
 *      card details are revealed and the consent_requests row is updated to
 *      'approved'.
 *
 *   2. `always_ask` + elicit accepted (decision="decline") → the tool returns
 *      a "PAYMENT DECLINED by user via inline consent" message, no card is
 *      revealed, and the row is updated to 'declined'.
 *
 *   3. `always_ask` + the host client does not advertise elicitation → the
 *      tool falls back to the text-based consent prompt (the same shape as
 *      `request_user_consent`) so legacy clients still settle the row via
 *      `submit_consent_decision`.
 *
 * Same harness as pay-for-service.test.ts — every I/O dependency is mocked,
 * the MCP server is faked with a minimal `{ tool }` capture, and we inject
 * `server.server.elicitInput` ourselves to drive the three responses.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

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

const VALID_TOKEN = "spx_" + "e".repeat(32);

const MOCK_USER = {
  id: "user_elicit",
  email: "elicit@example.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_elicit" as never,
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

const CONSENT_ROW = {
  id: "consent_elicit_1",
  user_id: MOCK_USER.id,
  action: "pay_for_service",
  service: "vercel",
  amount_usd: 20,
  context: null,
  options: ["approve", "decline"],
  status: "pending" as const,
  decision: null,
  decision_metadata: null,
  decision_made_at: null,
  expires_at: new Date(Date.now() + 300_000).toISOString(),
  created_at: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Server stub — we capture the handler AND swap out the underlying Server's
// `elicitInput` per-test to simulate accept / decline / unsupported.
// ---------------------------------------------------------------------------

type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

let handler:
  | ((input: Record<string, unknown>) => Promise<HandlerResult>)
  | undefined;

// `elicitInput` lives at McpServer.server.elicitInput. Mock the inner Server
// with a settable property so each test can install its own behavior.
const innerServer: { elicitInput?: unknown } = {};
const mockServer = {
  tool: vi.fn(),
  server: innerServer,
};

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
  vi.mocked(releaseIdempotencyKey).mockReset();
  vi.mocked(getOrCreateConsentPreferences).mockReset();
  vi.mocked(createConsentRequest).mockReset();
  vi.mocked(recordConsentDecision).mockReset();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config as any).emergencyStop = false;

  // Auth + spending-rules: clean defaults.
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getRulesForUser).mockResolvedValue([]);
  vi.mocked(getMonthlySpendUsd).mockResolvedValue(0);
  vi.mocked(getActiveVirtualCardForUser).mockResolvedValue({
    stripe_card_id: "ic_elicit_123",
  });
  vi.mocked(retrieveCardDetails).mockResolvedValue(MOCK_CARD);
  vi.mocked(logTransaction).mockResolvedValue(undefined);
  vi.mocked(acquireIdempotencyKey).mockReturnValue(true);
  vi.mocked(releaseIdempotencyKey).mockReturnValue(undefined);

  // Consent layer — the always_ask policy forces the elicit branch every
  // time. Individual tests inject the elicit response on `innerServer`.
  vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
    user_id: MOCK_USER.id,
    default_mode: "always_ask",
    auto_below_threshold_usd: null,
    trusted_services: [],
    notification_channels: [],
    telegram_chat_id: null,
    email_for_consent: null,
  });
  vi.mocked(createConsentRequest).mockResolvedValue(CONSENT_ROW);
  vi.mocked(recordConsentDecision).mockResolvedValue(null);

  // Clear the elicit shim — each test installs its own.
  delete innerServer.elicitInput;
});

// ---------------------------------------------------------------------------
// 1. always_ask + elicit accepted (decision = "approve") → charge proceeds
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — elicit accept (approve)", () => {
  it("reveals the virtual card, logs the transaction, and updates the consent row to approved", async () => {
    const elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { decision: "approve" },
    });
    innerServer.elicitInput = elicitInput;

    const result = await handler!(INPUT);

    // The elicitation dialog was triggered with the expected envelope.
    expect(elicitInput).toHaveBeenCalledTimes(1);
    const elicitCall = elicitInput.mock.calls[0]![0] as {
      mode: string;
      message: string;
      requestedSchema: {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
      };
    };
    expect(elicitCall.mode).toBe("form");
    expect(elicitCall.message).toContain("Pay $20.00 on vercel");
    expect(elicitCall.message).toContain("Upgrade to Pro plan");
    expect(elicitCall.requestedSchema.required).toContain("decision");

    // The consent row was created BEFORE the elicit (audit-trail invariant).
    expect(vi.mocked(createConsentRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createConsentRequest)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "vercel",
        amountUsd: 20,
        action: "pay_for_service",
      })
    );

    // The row was then updated to 'approved'.
    expect(vi.mocked(recordConsentDecision)).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CONSENT_ROW.id,
        userId: MOCK_USER.id,
        status: "approved",
        decision: "approve",
      })
    );

    // And the user got the card-reveal response.
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^APPROVED/);
    expect(result.content[0]!.text).toContain("4242 4242 4242 4242");

    // Audit log records the successful charge.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        service: "vercel",
        amountUsd: 20,
        transactionType: "one_shot",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// 2. always_ask + elicit accepted (decision = "decline") → return decline msg
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — elicit accept (decline)", () => {
  it("returns the inline-decline message and does NOT reveal the card", async () => {
    const elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { decision: "decline" },
    });
    innerServer.elicitInput = elicitInput;

    const result = await handler!(INPUT);

    expect(elicitInput).toHaveBeenCalledTimes(1);

    // Consent row created and then marked declined.
    expect(vi.mocked(createConsentRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordConsentDecision)).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CONSENT_ROW.id,
        status: "declined",
        decision: "decline",
      })
    );

    // No card reveal, no charge.
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(acquireIdempotencyKey)).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/PAYMENT DECLINED by user via inline consent/);
    expect(text).toContain("vercel");
    expect(text).not.toMatch(/4242/);

    // Audit log captures the consent decline as a failed payment attempt.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "payment_failed",
        service: "vercel",
        transactionType: "consent_declined",
        description: expect.stringContaining("consent declined via elicit"),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// 3. always_ask + client does not support elicitation → text fallback
// ---------------------------------------------------------------------------

describe("registerPayForServiceTool — elicit unsupported (text fallback)", () => {
  it("returns the legacy text-based consent prompt when the client has no elicitInput", async () => {
    // Leave innerServer.elicitInput unset (deleted in beforeEach) to simulate
    // a client that never advertised the capability.
    expect(innerServer.elicitInput).toBeUndefined();

    const result = await handler!(INPUT);

    // The consent row is still created so the legacy submit_consent_decision
    // flow can settle it.
    expect(vi.mocked(createConsentRequest)).toHaveBeenCalledTimes(1);

    // No decision was recorded — that happens via submit_consent_decision.
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();

    // No card reveal.
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/CONSENT NEEDED/);
    expect(text).toContain(CONSENT_ROW.id);
    expect(text).toMatch(/submit_consent_decision/);

    // Audit log notes that the consent prompt was deferred.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "payment_failed",
        transactionType: "consent_pending",
      })
    );
  });

  it("falls back to the text prompt when elicitInput throws (client capability missing)", async () => {
    // Some clients expose the method but throw because they never advertised
    // the elicitation capability — the SDK does this itself. Verify we still
    // fall back cleanly.
    const elicitInput = vi
      .fn()
      .mockRejectedValue(new Error("Client does not support form elicitation."));
    innerServer.elicitInput = elicitInput;

    const result = await handler!(INPUT);

    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/CONSENT NEEDED/);
    expect(result.content[0]!.text).toContain(CONSENT_ROW.id);
  });
});
