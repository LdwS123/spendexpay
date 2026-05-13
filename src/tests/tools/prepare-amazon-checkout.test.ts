/**
 * Tests for the legacy `prepare_amazon_checkout` tool alias.
 *
 * After the v0.3 refactor, this tool is a thin wrapper around the universal
 * `prepare_checkout` (see prepare-checkout.test.ts for the full surface). The
 * tests below only verify the backwards-compatibility contract:
 *
 *   - DEV mode still returns a recognisable Amazon playbook header.
 *   - The legacy `use_amazon_account` enum maps correctly to the new
 *     `login_strategy` field ("user_personal" → "user_existing").
 *   - The handler still goes through authentication, virtual-card lookup,
 *     managed-account decryption, and audit log under merchant_id="amazon".
 *   - No PII (PAN, CVC, password) leaks into the audit log description.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

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

const devModeHolder = { current: false };
vi.mock("../../config.js", () => ({
  get DEV_MODE() {
    return devModeHolder.current;
  },
  config: { emergencyStop: false },
}));

import {
  getActiveVirtualCardForUser,
  getManagedAccountByService,
  logTransaction,
} from "../../lib/db.js";
import { authenticateToolCall } from "../../lib/tool-auth.js";
import { retrieveCardDetails } from "../../lib/stripe-issuing.js";
import { decryptSecret } from "../../lib/crypto.js";
import { registerPrepareAmazonCheckoutTool } from "../../tools/prepare-amazon-checkout.js";

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

describe("legacy prepare_amazon_checkout — DEV mode", () => {
  it("returns the simulated Amazon playbook without touching DB", async () => {
    devModeHolder.current = true;

    const result = await handler!(VALID_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    // The universal renderer prefixes the header with the merchant display name.
    expect(text).toMatch(/AMAZON\.COM CHECKOUT PLAYBOOK/);
    expect(text).toContain("merchant_id:    amazon");
    expect(text).toContain(VALID_INPUT.product_url);
    // Dev-mode placeholder card.
    expect(text).toMatch(/4242 4242 4242 4242/);

    expect(vi.mocked(authenticateToolCall)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});

describe("legacy prepare_amazon_checkout — real path", () => {
  it("delegates to the universal handler with merchant=amazon and audits as checkout_playbook", async () => {
    const result = await handler!(VALID_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;

    // Login block — managed credentials surfaced verbatim.
    expect(text).toContain("signup-abc@mail.spendexai.com");
    expect(text).toContain("S3cret-Plaintext-Password!");

    // Variant options block.
    expect(text).toContain('color = "black"');
    expect(text).toContain('size = "M"');

    // Card details (grouped + expiry + CVV).
    expect(text).toContain("4000 0099 9000 0013");
    expect(text).toContain("02/29");
    expect(text).toContain("CVV:    123");

    // Place-order selector survived the refactor.
    expect(text).toMatch(/#placeYourOrder1/);

    // Audit log row written under the new transaction_type.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledTimes(1);
    const logArgs = vi.mocked(logTransaction).mock.calls[0]![0];
    expect(logArgs.transactionType).toBe("checkout_playbook");
    expect(logArgs.service).toBe("amazon");
    expect(logArgs.status).toBe("success");
    expect(logArgs.amountUsd).toBe(0);
    expect(logArgs.description).toContain(VALID_INPUT.product_url);
    expect(logArgs.description).not.toContain("S3cret-Plaintext-Password!");
    expect(logArgs.description).not.toContain("4000009990000013");
  });

  it('maps use_amazon_account="user_personal" to login_strategy="user_existing" and emits no credentials', async () => {
    const result = await handler!({
      ...VALID_INPUT,
      use_amazon_account: "user_personal",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;

    // user_existing block must be present.
    expect(text).toContain("LOGIN — user_existing");
    // And no managed credentials whatsoever.
    expect(text).not.toContain("signup-abc@mail.spendexai.com");
    expect(text).not.toContain("S3cret-Plaintext-Password!");

    // Managed-account lookup must be skipped when user_existing.
    expect(vi.mocked(getManagedAccountByService)).not.toHaveBeenCalled();
  });
});

describe("legacy prepare_amazon_checkout — missing virtual card", () => {
  it("returns a graceful decline and never calls Stripe or writes audit", async () => {
    vi.mocked(getActiveVirtualCardForUser).mockResolvedValue(null);

    const result = await handler!(VALID_INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toMatch(/CHECKOUT NOT PREPARED/);
    expect(text).toMatch(/no active Spendex virtual card/);

    expect(vi.mocked(retrieveCardDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(getManagedAccountByService)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});
