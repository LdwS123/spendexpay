/**
 * Tests for src/tools/signup-to-service.ts — explicit-consent enforcement.
 *
 * These tests pin down audit finding #90: creating a third-party account on
 * the user's behalf must require an EXPLICIT opt-in (`allow_auto_signup =
 * true`). Three branches:
 *
 *   1. allowance === null  → tool guides the agent to request_user_consent.
 *                             It does NOT proceed, but it is also not an
 *                             infrastructure error (no isError flag).
 *   2. allowance === false → tool declines with a "user opted out" message.
 *   3. allowance === true  → tool proceeds and returns READY TO SIGN UP.
 *
 * All I/O is mocked so the suite runs offline.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must precede any import of the modules under test.
// ---------------------------------------------------------------------------

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  getAutoSignupAllowance: vi.fn(),
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
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "b".repeat(32);

const MOCK_USER = {
  id: "user_consent",
  email: "bob@example.com",
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

const INPUT = {
  service: "modal",
  user_intent: "run a GPU job",
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
  registerSignupToServiceTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(getAutoSignupAllowance).mockReset();
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
  vi.mocked(getActiveVirtualCardForUser).mockResolvedValue({
    stripe_card_id: "ic_test_consent",
  });
  vi.mocked(retrieveCardDetails).mockResolvedValue({
    number: "4242424242424242",
    expMonth: 12,
    expYear: 2030,
    cvc: "123",
    brand: "Visa",
    last4: "4242",
  });
  vi.mocked(generateShortHash).mockReturnValue("c0nsentXYZ12");
  vi.mocked(generateSecurePassword).mockReturnValue("ConsentPassword-32-Chars-Strong");
  vi.mocked(encryptSecret).mockReturnValue("iv:tag:ciphertext");
  vi.mocked(createManagedAccount).mockResolvedValue({
    id: "22222222-2222-2222-2222-222222222222",
    user_id: MOCK_USER.id,
    service: "modal",
    email_alias: "signup-c0nsentXYZ12@mail.spendexai.com",
    password_encrypted: "iv:tag:ciphertext",
    status: "pending",
    external_account_id: null,
    created_at: new Date().toISOString(),
  });
  vi.mocked(logTransaction).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// allowance === null → guide to request_user_consent
// ---------------------------------------------------------------------------

describe("registerSignupToServiceTool — explicit consent required", () => {
  it("guides the agent to request_user_consent when allowance is null (never configured)", async () => {
    vi.mocked(getAutoSignupAllowance).mockResolvedValue(null);

    const result = await handler!(INPUT);

    // Informational refusal — not an infrastructure error.
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/AUTO-SIGNUP REQUIRES EXPLICIT CONSENT/);
    expect(text).toMatch(/request_user_consent/);
    expect(text).toMatch(/action="signup_to_service"/);
    expect(text).toContain('service="modal"');
    // Mention the legal binding so the agent understands why.
    expect(text).toMatch(/Terms of Service/);

    // CRITICAL: no credentials issued, no card revealed, no DB writes.
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(createManagedAccount)).not.toHaveBeenCalled();
    expect(vi.mocked(generateSecurePassword)).not.toHaveBeenCalled();
    expect(vi.mocked(generateShortHash)).not.toHaveBeenCalled();
    expect(vi.mocked(encryptSecret)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });

  it("declines politely when the user has explicitly opted out (allowance === false)", async () => {
    vi.mocked(getAutoSignupAllowance).mockResolvedValue(false);

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    // Different wording from the null branch — this is an explicit opt-out.
    expect(text).toMatch(/explicitly disabled auto-signup/);
    expect(text).not.toMatch(/AUTO-SIGNUP REQUIRES EXPLICIT CONSENT/);

    // CRITICAL: no credentials issued.
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(createManagedAccount)).not.toHaveBeenCalled();
    expect(vi.mocked(generateSecurePassword)).not.toHaveBeenCalled();
  });

  it("proceeds only when allowance === true and returns READY TO SIGN UP", async () => {
    vi.mocked(getAutoSignupAllowance).mockResolvedValue(true);

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/^READY TO SIGN UP/);
    expect(text).toContain("Service: modal");
    expect(text).toContain("signup-c0nsentXYZ12@mail.spendexai.com");
    expect(text).toContain("ConsentPassword-32-Chars-Strong");
    expect(text).toContain("4242 4242 4242 4242");

    // The full happy path actually ran.
    expect(vi.mocked(createManagedAccount)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(retrieveCardDetails)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "modal",
        status: "success",
        transactionType: "managed_signup",
      })
    );
  });
});
