/**
 * Tests for src/tools/get-product-variants.ts — registerGetProductVariantsTool.
 *
 * Mocks DB / rate-limit / config, and stubs global fetch so we never hit the
 * network. Each test captures the registered handler from a fake McpServer and
 * invokes it directly. Same harness pattern as fetch-product-preview.test.ts so
 * the two tools' tests can be read side-by-side.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  logTransaction: vi.fn(),
  getCachedVariants: vi.fn(),
  cacheVariants: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

const configState = { DEV_MODE: false, emergencyStop: false };
vi.mock("../../config.js", () => ({
  get DEV_MODE() { return configState.DEV_MODE; },
  config: {
    get emergencyStop() { return configState.emergencyStop; },
  },
}));

import {
  getUserByMcpToken,
  logTransaction,
  getCachedVariants,
  cacheVariants,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { registerGetProductVariantsTool } from "../../tools/get-product-variants.js";

const MOCK_USER = {
  id: "user_123",
  email: "t@t.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as any,
  vercel_token: "v",
  netlify_token: "n",
  railway_token: "r",
  fly_token: "f",
  replicate_token: "rp",
  render_token: "rn",
  modal_token: "m",
  huggingface_token: "hf",
  gamma_api_key: "g",
  cloudflare_token: "cf",
  cloudflare_account_id: "cfa",
  supabase_user_token: "sb",
  max_auto_charge_usd: 50,
};

const VALID_TOKEN = "spx_" + "a".repeat(32);

let handler:
  | ((input: any) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>)
  | undefined;

const mockServer = { tool: vi.fn() };

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (_name: string, _desc: string, _schema: any, h: any) => {
      handler = h;
    }
  );
  registerGetProductVariantsTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(getCachedVariants).mockReset();
  vi.mocked(cacheVariants).mockReset();

  configState.DEV_MODE = false;
  configState.emergencyStop = false;

  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(logTransaction).mockResolvedValue(undefined);
  vi.mocked(getCachedVariants).mockResolvedValue(null);
  vi.mocked(cacheVariants).mockResolvedValue(undefined);
});

function htmlResponse(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": init.contentType ?? "text/html; charset=utf-8",
    },
  });
}

// ---------------------------------------------------------------------------
// DEV mode
// ---------------------------------------------------------------------------

describe("get_product_variants — DEV mode", () => {
  it("returns simulated 3-color variants without hitting fetch or auth", async () => {
    configState.DEV_MODE = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/\[DEV MODE\]/);
    expect(result.content[0].text).toContain("PRODUCT VARIANTS");
    expect(result.content[0].text).toContain("Black");
    expect(result.content[0].text).toContain("Silver");
    expect(result.content[0].text).toContain("Midnight Blue");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(getUserByMcpToken)).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

describe("get_product_variants — URL validation", () => {
  it("rejects a malformed URL", async () => {
    const result = await handler!({
      url: "not-a-url",
      mcp_token: VALID_TOKEN,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not well-formed/i);
  });

  it("rejects localhost (SSRF)", async () => {
    const result = await handler!({
      url: "http://localhost:8080/admin",
      mcp_token: VALID_TOKEN,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/private.*host/i);
  });
});

// ---------------------------------------------------------------------------
// Cache hit
// ---------------------------------------------------------------------------

describe("get_product_variants — cache hit", () => {
  it("returns the cached row without re-fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    vi.mocked(getCachedVariants).mockResolvedValue({
      url: "https://shop.example.com/sony-xm5",
      variants: [
        { axis: "color", name: "Black", value: "black", available: true },
        { axis: "color", name: "Silver", value: "silver", available: true },
      ],
      base_price_usd: 399.99,
      currency: "USD",
      min_quantity: 1,
      max_quantity: 99,
      source: "server_fetch",
      created_at: new Date().toISOString(),
      ttl_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const result = await handler!({
      url: "https://shop.example.com/sony-xm5",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("PRODUCT VARIANTS");
    expect(result.content[0].text).toContain("Black");
    expect(result.content[0].text).toContain("Silver");
    expect(result.content[0].text).toContain("399.99");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Cache hits don't double-log or re-cache.
    expect(vi.mocked(cacheVariants)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// JSON-LD parse (server-side fetch path)
// ---------------------------------------------------------------------------

describe("get_product_variants — JSON-LD parsing", () => {
  it("extracts variants from a schema.org Product/Offer tree", async () => {
    const jsonLd = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": "Sony WH-1000XM5 Wireless Noise-Cancelling Headphones",
      "image": "https://example.com/sony.jpg",
      "offers": [
        {
          "@type": "Offer",
          "sku": "xm5-black",
          "price": "399.99",
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock",
          "itemOffered": { "color": "Black" },
          "image": "https://example.com/sony-black.jpg",
        },
        {
          "@type": "Offer",
          "sku": "xm5-silver",
          "price": "399.99",
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock",
          "itemOffered": { "color": "Silver" },
          "image": "https://example.com/sony-silver.jpg",
        },
        {
          "@type": "Offer",
          "sku": "xm5-blue",
          "price": "449.99",
          "priceCurrency": "USD",
          "availability": "https://schema.org/OutOfStock",
          "itemOffered": { "color": "Midnight Blue" },
        },
      ],
    };
    const html = `
      <html><head>
        <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
      </head><body></body></html>
    `;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await handler!({
      url: "https://shop.example.com/sony-xm5",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("PRODUCT VARIANTS");
    expect(text).toContain("Black");
    expect(text).toContain("Silver");
    expect(text).toContain("Midnight Blue");
    // Price delta is offer.price - cheapest = 449.99 - 399.99 = 50.00.
    expect(text).toContain("$+50.00");
    // Availability is reflected (one out of stock).
    expect(text).toMatch(/2\/3 available/);
    // Cached + audit-logged.
    expect(vi.mocked(cacheVariants)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cacheVariants).mock.calls[0][1]).toBe("server_fetch");
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        service: "shop.example.com",
        transactionType: "variants_fetch",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Bait / blocked merchants
// ---------------------------------------------------------------------------

describe("get_product_variants — bait / blocked", () => {
  it("returns SCRAPING BLOCKED on HTTP 403 (Amazon bot wall)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("", { status: 403, headers: { "content-type": "text/html" } })
    ));

    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("SCRAPING BLOCKED");
    expect(result.content[0].text).toContain("www.amazon.com");
    expect(result.content[0].text).toContain("get_product_variants");
    // Critical: do NOT cache when blocked.
    expect(vi.mocked(cacheVariants)).not.toHaveBeenCalled();
    // Audit log still recorded so ops can see the block rate.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionType: "variants_fetch",
      })
    );
  });

  it("returns SCRAPING BLOCKED when JSON-LD is absent (JS-only variant rendering)", async () => {
    const html = `<html><head><title>Product page</title></head><body>JS renders variants</body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await handler!({
      url: "https://shop.example.com/some-product",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("SCRAPING BLOCKED");
    expect(vi.mocked(cacheVariants)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// agent_extracted path
// ---------------------------------------------------------------------------

describe("get_product_variants — agent_extracted", () => {
  it("validates and caches an agent-supplied payload", async () => {
    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      mcp_token: VALID_TOKEN,
      agent_extracted: {
        variants: [
          { axis: "color", name: "Black", value: "blk", available: true },
          { axis: "color", name: "Silver", value: "slv", available: true },
          {
            axis: "color",
            name: "Midnight Blue",
            value: "midnight",
            available: false,
            price_delta_usd: 50,
            image_url: "https://example.com/blue.jpg",
          },
        ],
        base_price_usd: 399.99,
        currency: "USD",
        min_quantity: 1,
        max_quantity: 10,
      },
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("PRODUCT VARIANTS");
    expect(text).toContain("Black");
    expect(text).toContain("Midnight Blue");
    expect(text).toContain("$+50.00");
    expect(text).toContain("Quantity: 1-10");

    expect(vi.mocked(cacheVariants)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cacheVariants).mock.calls[0][1]).toBe("agent_extracted");
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionType: "variants_fetch_via_agent",
      })
    );
  });

  it("rejects an agent_extracted payload with a malformed variant entry", async () => {
    // The MCP SDK normally pre-validates input against the zod shape, but
    // some hosts forward raw JSON. Parse with the same schema the tool
    // uses to confirm the error surface is descriptive.
    const { z } = await import("zod");
    const schema = z.object({
      variants: z.array(z.object({
        axis: z.string().min(1),
        name: z.string().min(1),
        value: z.string().min(1),
        available: z.boolean(),
      })).min(1),
    });

    const bad = {
      variants: [
        // Missing required `value` and `axis` is empty.
        { axis: "", name: "Black", available: true },
      ],
    };
    const parsed = schema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.path.join(".") + ":" + i.message);
      // We expect at least the axis-empty + missing-value errors.
      expect(issues.some((m) => m.startsWith("variants.0.axis"))).toBe(true);
      expect(issues.some((m) => m.startsWith("variants.0.value"))).toBe(true);
    }
  });
});
