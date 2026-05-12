/**
 * Tests for src/tools/prepare-amazon-checkout.ts —
 * registerPrepareAmazonCheckoutTool.
 *
 * All I/O is mocked (DB, tool-auth, Stripe Issuing, crypto) so the suite
 * never touches the network or persists anything. The handler is captured via
 * a fake McpServer so it can be invoked directly and asserted against.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing anything that pulls in these
// modules. vi.mock is hoisted to the top of the file by Vitest.
// ---------------------------------------------------------------------------

vi.mock("../../lib/db.js", () => ({
  getActiveVirtualCardForUser: vi.fn(),
  getManagedAccountByService: vi.fn(),
  logTransaction: vi.fn(),
}));

vi.mock("../../lib/tool-auth.js", () => ({
  authenticateToolCall: vi.fn(),
}));

vi.mock("../../lib/stripe-issuing.js", () => ({
  retrieveCardDetails: vi.fn(),
}));

vi.mock("../../lib/crypto.js", () => ({
  decryptSecret: vi.fn(),
}));

// DEV_MODE flips per-test via a mutable holder so we can exercise both code
// paths without re-importing the module.
const devModeHolder = { current: false };
vi.mock("../../config.js", () => ({
  get DEV_MODE() {
    return devModeHolder.current;
  },
  config: { emergencyStop: false },
}));

// ---------------------------------------------------------------------------
// Imports — after the mock declarations above.
// ---------------------------------------------------------------------------

import {
  getActiveVirtualCardForUser,
  getManagedAccountByService,
  logTransaction,
} from "../../lib/db.js";
import { authenticateToolCall } from "../../lib/tool-auth.js";
import { retrieveCardDetails } from "../../lib/stripe-issuing.js";
import { decryptSecret } from "../../lib/crypto.js";
import { registerPrepareAmazonCheckoutTool } from "../../tools/prepare-amazon-checkout.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "a".repeat(32);

const MOCK_USER = {
  id: "user_amz_1",
  email: "alice@example.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as any,
  max_auto_charge_usd: 500,
};

const MOCK_CARD = {
  number: "4000009990000013",
  expMonth: 2,
  expYear: 2029,
  cvc: "123",
  brand: "Visa",
  last4: "0013",
};

const MOCK_MANAGED_ACCOUNT = {
  id: "11111111-1111-1111-1111-111111111111",
  user_id: MOCK_USER.id,
  service: "amazon",
  email_alias: "signup-abc@mail.spendexai.com",
  password_encrypted: "encrypted-blob",
  status: "active" as const,
  external_account_id: null,
  created_at: "2026-05-13T00:00:00.000Z",
};

const VALID_INPUT = {
  product_url: "https://www.amazon.com/dp/B0CHWRXH8B",
  quantity: 1,
  variant_options: { color: "black", size: "M" },
  use_amazon_account: "spendex_managed" as const,
  mcp_token: VALID_TOKEN,
};

// ---------------------------------------------------------------------------
// Handler capture
// ---------------------------------------------------------------------------

type Handler = (input: any) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let handler: Handler | undefined;
const mockServer = { tool: vi.fn() };

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (_name: string, _desc: string, _schema: any, h: Handler) => {
      handler = h;
    }
  );
  registerPrepareAmazonCheckoutTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(authenticateToolCall).mockReset();
  vi.mocked(getActiveVirtualCardForUser).mockReset();
  vi.mocked(getManagedAccountByService).mockReset();
  vi.mocked(retrieveCardDetails).mockReset();
  vi.mocked(decryptSecret).mockReset();
  vi.mocked(logTransaction).mockReset();

  devModeHolder.current = false;

  // Happy-path defaults — individual tests override what they need.
  vi.mocked(authenticateToolCall).mockResolvedValue({
    ok: true,
    user: MOCK_USER as any,
  } as any);
  vi.mocked(getActiveVirtualCardForUser).mockResolvedValue({
    stripe_card_id: "ic_test",
  });
  vi.mocked(retrieveCardDetails).mockResolvedValue(MOCK_CARD);
  vi.mocked(getManagedAccountByService).mockResolvedValue(
    MOCK_MANAGED_ACCOUNT as any
  );
  vi.mocked(decryptSecret).mockReturnValue("S3cret-Plaintext-Password!");
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerPrepareAmazonCheckoutTool — DEV mode", () => {
  it("returns the simulated playbook without touching DB, auth, or Stripe", async () => {
    devModeHolder.current = true;

    const result = await handler!(VALID_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    // Playbook header must be present so the agent's parser recognises the
    // shape even in dev mode.
    expect(text).toMatch(/AMAZON CHECKOUT PLAYBOOK/);
    // Product URL is echoed back verbatim in step 2.
    expect(text).toContain(VALID_INPUT.product_url);
    // Dev-mode placeholder card (Stripe test PAN 4242…) must be used so a
    // leaked playbook cannot be charged.
    expect(text).toMatch(/4242 4242 4242 4242/);

    // None of the prod paths should fire in DEV mode.
    expect(vi.mocked(authenticateToolCall)).not.toHaveBeenCalled();
    expect(vi.mocked(getActiveVirtualCardForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(getManagedAccountByService)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});

describe("registerPrepareAmazonCheckoutTool — real path", () => {
  it("emits a step-by-step playbook with the live card details and managed credentials, and audits the prepare event", async () => {
    const result = await handler!(VALID_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;

    // Login step — managed credentials surfaced verbatim so the agent can
    // type them into Amazon's signin form.
    expect(text).toContain("signup-abc@mail.spendexai.com");
    expect(text).toContain("S3cret-Plaintext-Password!");

    // Variant clicks — both axes from variant_options must appear in step 3.
    expect(text).toContain('Click color "black"');
    expect(text).toContain('Click size "M"');

    // Card details — PAN formatted as 4 groups of 4 + expiry / CVV present.
    expect(text).toContain("4000 0099 9000 0013");
    expect(text).toContain("02/29");
    expect(text).toContain("CVV: 123");

    // Place-order selector must be present so the agent knows what to click.
    expect(text).toMatch(/#placeYourOrder1/);

    // Step 11 must instruct the agent to call complete_purchase with the
    // captured order ID and merchant.
    expect(text).toContain("complete_purchase");
    expect(text).toMatch(/merchant: "amazon"/);

    // Audit log row created in transactionType="checkout_prepared", no PII
    // (password / PAN / CVV) in the description.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledTimes(1);
    const logArgs = vi.mocked(logTransaction).mock.calls[0]![0];
    expect(logArgs.transactionType).toBe("checkout_prepared");
    expect(logArgs.service).toBe("amazon");
    expect(logArgs.status).toBe("success");
    expect(logArgs.amountUsd).toBe(0);
    expect(logArgs.description).toContain(VALID_INPUT.product_url);
    // Defense in depth: the description must NEVER carry the secrets.
    expect(logArgs.description).not.toContain("S3cret-Plaintext-Password!");
    expect(logArgs.description).not.toContain("4000009990000013");
    expect(logArgs.description).not.toContain("123");
  });
});

describe("registerPrepareAmazonCheckoutTool — missing virtual card", () => {
  it("returns a graceful decline and never calls Stripe or writes audit", async () => {
    vi.mocked(getActiveVirtualCardForUser).mockResolvedValue(null);

    const result = await handler!(VALID_INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toMatch(/CHECKOUT NOT PREPARED/);
    expect(text).toMatch(/no active Spendex virtual card/);
    expect(text).toMatch(/spendexai\.com\/dashboard\/payments/);

    // No card retrieval, no managed-account lookup, no audit row written.
    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(getManagedAccountByService)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});
