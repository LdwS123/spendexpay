/**
 * Tests for src/tools/signup-to-service.ts — registerSignupToServiceTool
 *
 * Every I/O dependency is mocked (DB, rate-limit, Stripe Issuing reveal,
 * crypto generators) so the tests run completely offline.
 *
 * Coverage:
 *   - DEV mode short-circuits without touching DB/Stripe and returns the
 *     simulated READY-TO-SIGN-UP response.
 *   - Explicit `allow_auto_signup = false` declines without issuing
 *     credentials or touching the card path.
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

const VALID_TOKEN = "spx_" + "a".repeat(32);

const MOCK_USER = {
  id: "user_sus",
  email: "alice@example.com",
  payment_method: "stripe_card" as const,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payment_provider_customer_id: "cus_test" as any,
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
  service: "vercel",
  user_intent: "deploy a Next.js app",
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

  // Happy-path defaults — individual tests override as needed.
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getAutoSignupAllowance).mockResolvedValue(null);
  vi.mocked(getActiveVirtualCardForUser).mockResolvedValue({
    stripe_card_id: "ic_test_123",
  });
  vi.mocked(retrieveCardDetails).mockResolvedValue({
    number: "4242424242424242",
    expMonth: 12,
    expYear: 2030,
    cvc: "123",
    brand: "Visa",
    last4: "4242",
  });
  vi.mocked(generateShortHash).mockReturnValue("abc123def456");
  vi.mocked(generateSecurePassword).mockReturnValue("StrongPassword!Mock-32-Chars-X");
  vi.mocked(encryptSecret).mockReturnValue("iv:tag:ciphertext");
  vi.mocked(createManagedAccount).mockResolvedValue({
    id: "11111111-1111-1111-1111-111111111111",
    user_id: MOCK_USER.id,
    service: "vercel",
    email_alias: "signup-abc123def456@mail.spendexai.com",
    password_encrypted: "iv:tag:ciphertext",
    status: "pending",
    external_account_id: null,
    created_at: new Date().toISOString(),
  });
  vi.mocked(logTransaction).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// DEV mode
// ---------------------------------------------------------------------------

describe("registerSignupToServiceTool — DEV mode", () => {
  it("returns the simulated READY response without touching DB or Stripe", async () => {
    vi.resetModules();

    vi.doMock("../../config.js", () => ({
      config: { emergencyStop: false },
      DEV_MODE: true,
    }));
    vi.doMock("../../lib/db.js", () => ({
      getUserByMcpToken: vi.fn(),
      getAutoSignupAllowance: vi.fn(),
      getActiveVirtualCardForUser: vi.fn(),
      createManagedAccount: vi.fn(),
      logTransaction: vi.fn(),
    }));
    vi.doMock("../../lib/rate-limit.js", () => ({ checkRateLimit: vi.fn() }));
    vi.doMock("../../lib/stripe-issuing.js", () => ({
      retrieveCardDetails: vi.fn(),
    }));
    vi.doMock("../../lib/crypto.js", () => ({
      encryptSecret: vi.fn(),
      generateSecurePassword: vi.fn(),
      generateShortHash: vi.fn(),
    }));

    const { registerSignupToServiceTool: devRegister } = await import(
      "../../tools/signup-to-service.js"
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
    expect(text).toMatch(/READY TO SIGN UP/);
    expect(text).toContain("vercel");
    expect(text).toContain("4242 4242 4242 4242");
    // Crucially: a DEV-mode call must never have touched the real DB.
    const { createManagedAccount: realCreate } = await import("../../lib/db.js");
    expect(vi.mocked(realCreate)).not.toHaveBeenCalled();

    vi.resetModules();
    vi.doUnmock("../../config.js");
    vi.doUnmock("../../lib/db.js");
    vi.doUnmock("../../lib/rate-limit.js");
    vi.doUnmock("../../lib/stripe-issuing.js");
    vi.doUnmock("../../lib/crypto.js");
  });
});

// ---------------------------------------------------------------------------
// allow_auto_signup = false → decline
// ---------------------------------------------------------------------------

describe("registerSignupToServiceTool — explicit opt-out", () => {
  it("declines and does NOT issue credentials when allow_auto_signup is false", async () => {
    vi.mocked(getAutoSignupAllowance).mockResolvedValue(false);

    const result = await handler!(INPUT);

    // Rule-driven decline — not an infrastructure error.
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/User has not authorized auto-signup/);
    expect(text).toMatch(/dashboard rules/);

    // Critical: no card reveal, no managed-account row, no password generated.
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(createManagedAccount)).not.toHaveBeenCalled();
    expect(vi.mocked(generateSecurePassword)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("registerSignupToServiceTool — happy path", () => {
  it("returns READY TO SIGN UP with the generated alias, password, and card", async () => {
    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;

    expect(text).toMatch(/^READY TO SIGN UP/);
    expect(text).toContain("Service: vercel");
    expect(text).toContain("signup-abc123def456@mail.spendexai.com");
    expect(text).toContain("StrongPassword!Mock-32-Chars-X");
    expect(text).toContain("4242 4242 4242 4242");
    expect(text).toContain("Expiry: 12/30");
    expect(text).toContain("11111111-1111-1111-1111-111111111111");
    // Agent-facing follow-up instructions must be present.
    expect(text).toMatch(/call complete_signup/);
    expect(text).toMatch(/call get_verification_email/);

    // The password we stored must be the encrypted blob, never plaintext.
    expect(vi.mocked(encryptSecret)).toHaveBeenCalledWith(
      "StrongPassword!Mock-32-Chars-X"
    );
    expect(vi.mocked(createManagedAccount)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "vercel",
        emailAlias: "signup-abc123def456@mail.spendexai.com",
        passwordEncrypted: "iv:tag:ciphertext",
      })
    );
    // Audit log written with the managed-account id as the agent_id.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "vercel",
        status: "success",
        transactionType: "managed_signup",
        agentId: "11111111-1111-1111-1111-111111111111",
      })
    );
  });
});
