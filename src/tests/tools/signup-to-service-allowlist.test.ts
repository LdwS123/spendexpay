/**
 * Tests for src/tools/signup-to-service.ts — per-service allowlist bypass.
 *
 * Migration 010 adds `user_consent_preferences.auto_signup_allowed_services`,
 * a per-user array of service slugs for which Spendex is allowed to create
 * accounts WITHOUT a fresh consent prompt. When `getAutoSignupAllowance`
 * returns `null` (the "never configured" branch — see the rules table), the
 * signup tool consults the allowlist before refusing:
 *
 *   - service IN allowlist  → fall through to the happy path, return
 *                              READY TO SIGN UP just like an explicit
 *                              `allow_auto_signup = true`.
 *   - service NOT IN list  → return the existing refusal message, plus a
 *                              hint pointing the user at
 *                              /dashboard/consents/preferences.
 *
 * The allowlist is NOT consulted when `allow_auto_signup = false` (explicit
 * opt-out wins). That branch is covered by `signup-to-service-consent.test.ts`.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must precede any import of the modules under test.
// ---------------------------------------------------------------------------

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  getAutoSignupAllowance: vi.fn(),
  getAutoSignupAllowedServices: vi.fn(),
  getActiveVirtualCardForUser: vi.fn(),
  createManagedAccount: vi.fn(),
  logTransaction: vi.fn(),
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

vi.mock("../../lib/crypto.js", () => ({
  encryptSecret: vi.fn(),
  generateSecurePassword: vi.fn(),
  generateShortHash: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  getUserByMcpToken,
  getAutoSignupAllowance,
  getAutoSignupAllowedServices,
  getActiveVirtualCardForUser,
  createManagedAccount,
  logTransaction,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import { retrieveCardDetails } from "../../lib/stripe-issuing.js";
import {
  encryptSecret,
  generateSecurePassword,
  generateShortHash,
} from "../../lib/crypto.js";
import { registerSignupToServiceTool } from "../../tools/signup-to-service.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "c".repeat(32);

const MOCK_USER = {
  id: "user_allowlist",
  email: "carol@example.com",
  payment_method: "stripe_card" as const,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payment_provider_customer_id: "cus_allowlist" as any,
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

// ---------------------------------------------------------------------------
// Handler capture
// ---------------------------------------------------------------------------

type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

let handler:
  | ((input: Record<string, unknown>) => Promise<HandlerResult>)
  | undefined;

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
  registerSignupToServiceTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(getAutoSignupAllowance).mockReset();
  vi.mocked(getAutoSignupAllowedServices).mockReset();
  vi.mocked(getActiveVirtualCardForUser).mockReset();
  vi.mocked(retrieveCardDetails).mockReset();
  vi.mocked(createManagedAccount).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(encryptSecret).mockReset();
  vi.mocked(generateSecurePassword).mockReset();
  vi.mocked(generateShortHash).mockReset();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config as any).emergencyStop = false;

  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  // The allowlist branch is reached ONLY when `getAutoSignupAllowance`
  // returns null (no rule configured). false/true are tested elsewhere.
  vi.mocked(getAutoSignupAllowance).mockResolvedValue(null);
  // Default allowlist for these tests — "openai" only.
  vi.mocked(getAutoSignupAllowedServices).mockResolvedValue(["openai"]);
  vi.mocked(getActiveVirtualCardForUser).mockResolvedValue({
    stripe_card_id: "ic_test_allowlist",
  });
  vi.mocked(retrieveCardDetails).mockResolvedValue({
    number: "4242424242424242",
    expMonth: 12,
    expYear: 2030,
    cvc: "123",
    brand: "Visa",
    last4: "4242",
  });
  vi.mocked(generateShortHash).mockReturnValue("allowABC1234");
  vi.mocked(generateSecurePassword).mockReturnValue(
    "AllowlistPassword-32-Chars-Ok!"
  );
  vi.mocked(encryptSecret).mockReturnValue("iv:tag:ciphertext-allowlist");
  vi.mocked(createManagedAccount).mockResolvedValue({
    id: "33333333-3333-3333-3333-333333333333",
    user_id: MOCK_USER.id,
    service: "openai",
    email_alias: "signup-allowABC1234@mail.spendexai.com",
    password_encrypted: "iv:tag:ciphertext-allowlist",
    status: "pending",
    external_account_id: null,
    created_at: new Date().toISOString(),
  });
  vi.mocked(logTransaction).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerSignupToServiceTool — per-service allowlist bypass", () => {
  it("bypasses the consent prompt and returns READY TO SIGN UP when the requested service is in the user's allowlist", async () => {
    // allowance = null (no rule), allowlist = ["openai"], service = "openai"
    const result = await handler!({
      service: "openai",
      user_intent: "call gpt-4o for a code review",
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/^READY TO SIGN UP/);
    expect(text).toContain("Service: openai");
    expect(text).toContain("signup-allowABC1234@mail.spendexai.com");
    expect(text).toContain("AllowlistPassword-32-Chars-Ok!");

    // CRITICAL: full happy path actually ran — the allowlist truly bypassed
    // the refusal, not just suppressed the error text.
    expect(vi.mocked(getAutoSignupAllowedServices)).toHaveBeenCalledWith(
      MOCK_USER.id
    );
    expect(vi.mocked(createManagedAccount)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(retrieveCardDetails)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "openai",
        status: "success",
        transactionType: "managed_signup",
      })
    );
  });

  it("refuses with the consent-required message + dashboard hint when the requested service is NOT in the allowlist", async () => {
    // allowance = null, allowlist = ["openai"], service = "stripe"
    const result = await handler!({
      service: "stripe",
      user_intent: "create a Stripe account for payouts",
      mcp_token: VALID_TOKEN,
    });

    // Informational refusal — not an infrastructure error.
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/AUTO-SIGNUP REQUIRES EXPLICIT CONSENT/);
    expect(text).toMatch(/request_user_consent/);
    expect(text).toContain('service="stripe"');
    // New hint pointing the user at the dashboard allowlist.
    expect(text).toMatch(
      /auto_signup_allowed_services.*\/dashboard\/consents\/preferences/s
    );

    // CRITICAL: no credentials issued, no DB writes for the managed account.
    expect(vi.mocked(getAutoSignupAllowedServices)).toHaveBeenCalledWith(
      MOCK_USER.id
    );
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(createManagedAccount)).not.toHaveBeenCalled();
    expect(vi.mocked(generateSecurePassword)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});
