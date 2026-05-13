/**
 * Tests for src/tools/prepare-checkout.ts — the universal multi-merchant
 * Computer-Use playbook generator.
 *
 * Surface covered:
 *   - Curated lookup: amazon, walmart, bestbuy, ebay, generic_stripe_checkout.
 *   - Domain lookup: URL → playbook (amazon.com, walmart.com, …).
 *   - Generic fallback when the merchant is unknown.
 *   - Login strategy variants (spendex_managed / user_existing / guest_checkout).
 *   - DEV mode bypass.
 *   - Token validation.
 *   - Audit log carries merchant + transaction_type="checkout_playbook".
 *   - Amount > cap surfaces a warning.
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
import { registerPrepareCheckoutTool } from "../../tools/prepare-checkout.js";

const VALID_TOKEN = "spx_" + "a".repeat(32);

const MOCK_USER = {
  id: "user_pc_1",
  email: "alice@example.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as any,
  max_auto_charge_usd: 500,
};

const MOCK_CARD = {
  number: "4000009990000013",
  expMonth: 2,
  expYear: 2029,
  cvc: "456",
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
  registerPrepareCheckoutTool(mockServer as any);
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

// ---------------------------------------------------------------------------
// Curated playbook lookup
// ---------------------------------------------------------------------------

describe("prepare_checkout — curated merchant lookup", () => {
  it('merchant="amazon" returns the curated Amazon playbook', async () => {
    const result = await handler!({
      merchant: "amazon",
      product_url: "https://www.amazon.com/dp/B0CHWRXH8B",
      amount_usd: 49.99,
      quantity: 1,
      variant_options: { color: "black" },
      login_strategy: "spendex_managed",
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("AMAZON.COM CHECKOUT PLAYBOOK");
    expect(text).toContain("merchant_id:    amazon");
    expect(text).toContain("curated:        yes");
    // Amazon's #placeYourOrder1 selector survives.
    expect(text).toMatch(/#placeYourOrder1/);
    // Managed-account credentials surfaced.
    expect(text).toContain("signup-abc@mail.spendexai.com");
    expect(text).toContain("S3cret-Plaintext-Password!");
  });

  it('merchant="walmart" returns the curated Walmart playbook with guest_checkout login', async () => {
    const result = await handler!({
      merchant: "walmart",
      product_url: "https://www.walmart.com/ip/12345",
      amount_usd: 29.99,
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("WALMART.COM CHECKOUT PLAYBOOK");
    expect(text).toContain("merchant_id:    walmart");
    expect(text).toContain("login_strategy: guest_checkout");
    // Walmart-specific selector.
    expect(text).toMatch(/data-automation-id="atc"/);
    // No managed credentials emitted for guest checkout.
    expect(text).not.toContain("signup-abc@mail.spendexai.com");
  });

  it('merchant="bestbuy" returns the curated Best Buy playbook', async () => {
    const result = await handler!({
      merchant: "bestbuy",
      product_url: "https://www.bestbuy.com/site/example/123.p",
      amount_usd: 199.99,
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("BEST BUY CHECKOUT PLAYBOOK");
    expect(text).toContain(".add-to-cart-button");
  });

  it('merchant="ebay" returns the curated eBay playbook with Buy-It-Now verify step', async () => {
    const result = await handler!({
      merchant: "ebay",
      product_url: "https://www.ebay.com/itm/123456",
      amount_usd: 75,
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("EBAY CHECKOUT PLAYBOOK");
    expect(text).toContain("Buy It Now");
  });

  it('merchant="generic_stripe_checkout" returns the curated Stripe playbook', async () => {
    const result = await handler!({
      merchant: "generic_stripe_checkout",
      product_url: "https://checkout.stripe.com/c/pay/abc123",
      amount_usd: 10,
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("GENERIC STRIPE CHECKOUT CHECKOUT PLAYBOOK");
    expect(text).toContain("PaymentElement");
  });
});

// ---------------------------------------------------------------------------
// Domain-based lookup
// ---------------------------------------------------------------------------

describe("prepare_checkout — URL/domain lookup", () => {
  it("URL with amazon.com hostname matches the Amazon playbook", async () => {
    const result = await handler!({
      merchant: "https://www.amazon.com/dp/B0CHWRXH8B",
      product_url: "https://www.amazon.com/dp/B0CHWRXH8B",
      amount_usd: 25,
      login_strategy: "user_existing",
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("merchant_id:    amazon");
    expect(text).toContain("curated:        yes");
  });
});

// ---------------------------------------------------------------------------
// Unknown merchant → generic fallback
// ---------------------------------------------------------------------------

describe("prepare_checkout — unknown merchant fallback", () => {
  it("unknown merchant returns the generic playbook with an explicit warning", async () => {
    const result = await handler!({
      merchant: "https://www.someobscureshop.example/products/123",
      product_url: "https://www.someobscureshop.example/products/123",
      amount_usd: 15,
      login_strategy: "guest_checkout",
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("curated:        no — generic fallback");
    expect(text).toMatch(/WARNING: no curated playbook/);
    // Generic playbook still tells the agent how to handle the card form.
    expect(text).toContain("CARD — Spendex virtual card");
    expect(text).toContain("4000 0099 9000 0013");
  });

  it("unknown merchant must NOT attempt managed-account lookup unless explicitly asked", async () => {
    await handler!({
      merchant: "novel-merchant",
      amount_usd: 5,
      login_strategy: "guest_checkout",
      mcp_token: VALID_TOKEN,
    });

    expect(vi.mocked(getManagedAccountByService)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DEV mode
// ---------------------------------------------------------------------------

describe("prepare_checkout — DEV mode", () => {
  it("returns simulated playbook without touching DB or auth", async () => {
    devModeHolder.current = true;

    const result = await handler!({
      merchant: "amazon",
      product_url: "https://www.amazon.com/dp/X",
      amount_usd: 42,
      mcp_token: "doesnt-matter-in-dev",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("AMAZON.COM CHECKOUT PLAYBOOK");
    // Stripe test PAN is used so leaked dev playbooks can't be charged.
    expect(text).toMatch(/4242 4242 4242 4242/);

    expect(vi.mocked(authenticateToolCall)).not.toHaveBeenCalled();
    expect(vi.mocked(getActiveVirtualCardForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });

  it("DEV mode works for unknown merchants too", async () => {
    devModeHolder.current = true;

    const result = await handler!({
      merchant: "totally-unknown-merchant",
      amount_usd: 1,
      mcp_token: "x",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("curated:        no — generic fallback");
  });
});

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

describe("prepare_checkout — token validation", () => {
  it("propagates the auth response when the token is rejected", async () => {
    vi.mocked(authenticateToolCall).mockResolvedValue({
      ok: false,
      response: {
        content: [{ type: "text" as const, text: "Authentication failed" }],
        isError: true,
      },
    } as any);

    const result = await handler!({
      merchant: "amazon",
      product_url: "https://www.amazon.com/dp/X",
      amount_usd: 10,
      mcp_token: "spx_invalid",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Authentication failed");
    expect(vi.mocked(getActiveVirtualCardForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe("prepare_checkout — audit log", () => {
  it("captures the merchant_id correctly under transaction_type=checkout_playbook", async () => {
    await handler!({
      merchant: "walmart",
      product_url: "https://www.walmart.com/ip/abc",
      amount_usd: 33,
      mcp_token: VALID_TOKEN,
    });

    expect(vi.mocked(logTransaction)).toHaveBeenCalledTimes(1);
    const logArgs = vi.mocked(logTransaction).mock.calls[0]![0];
    expect(logArgs.transactionType).toBe("checkout_playbook");
    expect(logArgs.service).toBe("walmart");
    expect(logArgs.status).toBe("success");
    expect(logArgs.amountUsd).toBe(0);
    expect(logArgs.description).toContain("Walmart.com");
    // No secrets in description.
    expect(logArgs.description).not.toContain("4000009990000013");
    expect(logArgs.description).not.toContain("S3cret-Plaintext-Password!");
  });

  it("uses the merchant_id from the generic fallback when no curated match", async () => {
    await handler!({
      merchant: "https://niche-shop.example/p/x",
      amount_usd: 1,
      login_strategy: "guest_checkout",
      mcp_token: VALID_TOKEN,
    });

    const logArgs = vi.mocked(logTransaction).mock.calls[0]![0];
    expect(logArgs.service).toBe("generic");
    expect(logArgs.transactionType).toBe("checkout_playbook");
  });
});

// ---------------------------------------------------------------------------
// Amount warning
// ---------------------------------------------------------------------------

describe("prepare_checkout — amount cap warning", () => {
  it("renders an AMOUNT WARNING block when amount_usd exceeds the per-auth cap", async () => {
    const result = await handler!({
      merchant: "amazon",
      product_url: "https://www.amazon.com/dp/X",
      amount_usd: 9999,
      login_strategy: "user_existing",
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/AMOUNT WARNING/);
    expect(text).toContain("9999.00");
    expect(text).toContain("500.00");
  });

  it("does NOT render the warning when amount is within the cap", async () => {
    const result = await handler!({
      merchant: "amazon",
      product_url: "https://www.amazon.com/dp/X",
      amount_usd: 100,
      login_strategy: "user_existing",
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).not.toMatch(/AMOUNT WARNING/);
  });
});
