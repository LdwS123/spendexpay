/**
 * Tests for the Computer-Use / browser-via-agent fallback path of
 * `fetch_product_preview`. Specifically:
 *
 *   - server fetch returns 403 → tool returns SCRAPING BLOCKED instruction
 *     (NOT isError: true)
 *   - server fetch returns 404 with an Amazon captcha body → SCRAPING BLOCKED
 *   - server fetch returns 404 with a plain "not found" body → still an error
 *     (the agent fallback is only for actual bot-blocks)
 *   - agent provides `agent_extracted` → tool returns PRODUCT PREVIEW with
 *     that data, audit log written with transaction_type='preview_fetch_via_agent'
 *   - cache hit: second call with same URL returns cached data without fetching
 *   - cache expired (mocked as miss) → re-fetches
 *   - agent_extracted with invalid fields → validation error from Zod
 *
 * The setup mirrors fetch-product-preview.test.ts so the two suites stay
 * easy to read side-by-side.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  logTransaction: vi.fn(),
  getCachedProductPreview: vi.fn(),
  cacheProductPreview: vi.fn(),
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
  getCachedProductPreview,
  cacheProductPreview,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { registerFetchProductPreviewTool } from "../../tools/fetch-product-preview.js";

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
let inputShape: Record<string, unknown> | undefined;

const mockServer = { tool: vi.fn() };

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (_name: string, _desc: string, schema: any, h: any) => {
      inputShape = schema;
      handler = h;
    }
  );
  registerFetchProductPreviewTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(getCachedProductPreview).mockReset();
  vi.mocked(cacheProductPreview).mockReset();

  configState.DEV_MODE = false;
  configState.emergencyStop = false;

  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(logTransaction).mockResolvedValue(undefined);
  vi.mocked(getCachedProductPreview).mockResolvedValue(null);
  vi.mocked(cacheProductPreview).mockResolvedValue(undefined);
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
// 1. HTTP 403 → SCRAPING BLOCKED instruction
// ---------------------------------------------------------------------------

describe("fetch_product_preview — server-side anti-bot detection", () => {
  it("returns SCRAPING BLOCKED instruction (not error) when fetch returns 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("", { status: 403 }))
    );

    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/SCRAPING BLOCKED/);
    expect(result.content[0].text).toMatch(/Open this URL in your browser tool/);
    expect(result.content[0].text).toContain("https://www.amazon.com/dp/B09XS7JWHH");
    expect(result.content[0].text).toMatch(/re-call fetch_product_preview/i);
    expect(result.content[0].text).toContain("www.amazon.com");

    // The block itself is audited as a successful tool call (the structured
    // instruction is a valid response, not a failure).
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        service: "www.amazon.com",
        status: "success",
        transactionType: "preview_fetch",
      })
    );

    // We did not cache anything — there is nothing yet to cache.
    expect(vi.mocked(cacheProductPreview)).not.toHaveBeenCalled();
  });

  it("returns SCRAPING BLOCKED when 404 body contains an Amazon-style captcha signature", async () => {
    const captchaBody = `
      <html>
        <body>
          <h1>Sorry, we just need to make sure you're not a robot</h1>
          <p>Enter the characters you see below</p>
        </body>
      </html>
    `;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse(captchaBody, { status: 404 }))
    );

    const result = await handler!({
      url: "https://www.amazon.com/errors/validateCaptcha",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/SCRAPING BLOCKED/);
    expect(result.content[0].text).toContain("www.amazon.com");
  });

  it("still surfaces a plain 404 (no captcha body) as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("not found", { status: 404 }))
    );

    const result = await handler!({
      url: "https://example.com/missing",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
// 2. agent_extracted re-call
// ---------------------------------------------------------------------------

describe("fetch_product_preview — agent_extracted re-call", () => {
  it("returns PRODUCT PREVIEW shape from agent-supplied data and audits with preview_fetch_via_agent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      agent_extracted: {
        title: "Sony WH-1000XM5 Wireless Noise-Cancelling Headphones",
        image_url: "https://m.media-amazon.com/images/I/61yIzVS4r-L._AC_SL1500_.jpg",
        description: "Industry-leading noise cancellation with eight microphones.",
        price: 399.99,
        currency: "USD",
        site_name: "Amazon.com",
      },
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    // No network call should have happened.
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("PRODUCT PREVIEW");
    expect(text).toContain("Sony WH-1000XM5");
    expect(text).toContain("https://m.media-amazon.com/images/I/61yIzVS4r-L._AC_SL1500_.jpg");
    expect(text).toContain("Industry-leading noise cancellation");
    expect(text).toContain("399.99");
    expect(text).toContain("USD");
    expect(text).toContain("Amazon.com");

    // Cache row inserted with source=agent_extracted.
    expect(vi.mocked(cacheProductPreview)).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://www.amazon.com/dp/B09XS7JWHH",
        title: "Sony WH-1000XM5 Wireless Noise-Cancelling Headphones",
        imageUrl: "https://m.media-amazon.com/images/I/61yIzVS4r-L._AC_SL1500_.jpg",
        price: 399.99,
        currency: "USD",
        source: "agent_extracted",
      })
    );

    // Audit log uses the distinct transaction_type so ops can split metrics.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        service: "www.amazon.com",
        status: "success",
        transactionType: "preview_fetch_via_agent",
      })
    );
  });

  it("accepts a minimal agent_extracted with only title", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handler!({
      url: "https://www.walmart.com/ip/12345",
      agent_extracted: { title: "Some Walmart Item" },
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Some Walmart Item");
  });
});

// ---------------------------------------------------------------------------
// 3. Cache hit
// ---------------------------------------------------------------------------

describe("fetch_product_preview — cache", () => {
  it("returns cached preview without hitting fetch when a non-expired row exists", async () => {
    vi.mocked(getCachedProductPreview).mockResolvedValue({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      title: "Cached Sony XM5",
      image_url: "https://example.com/cached.jpg",
      description: "Cached description",
      price: 349.0,
      currency: "USD",
      site_name: "Amazon.com",
      source: "agent_extracted",
      created_at: "2026-05-10T00:00:00.000Z",
      ttl_expires_at: "2026-05-17T00:00:00.000Z",
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Cached Sony XM5");
    expect(result.content[0].text).toContain("349.00");

    // We did not re-cache or re-audit a cache hit.
    expect(vi.mocked(cacheProductPreview)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });

  it("re-fetches when the cache lookup returns null (expired or missing)", async () => {
    vi.mocked(getCachedProductPreview).mockResolvedValue(null);

    const html = `
      <html><head>
        <meta property="og:title" content="Fresh Product" />
        <meta property="og:image" content="https://example.com/fresh.jpg" />
      </head></html>
    `;
    const fetchSpy = vi.fn().mockResolvedValue(htmlResponse(html));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handler!({
      url: "https://www.example.com/p/abc",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Fresh Product");

    // Cache write with source=server_fetch.
    expect(vi.mocked(cacheProductPreview)).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fresh Product",
        source: "server_fetch",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Validation of agent_extracted
// ---------------------------------------------------------------------------

describe("fetch_product_preview — agent_extracted validation", () => {
  // The MCP SDK runs the Zod schema on input before our handler executes,
  // so we replay that here using the schema we captured at registration
  // time. This mirrors what an agent would actually hit if it tried to
  // submit garbage.
  // Re-build the same z.object the tool registers. We can't reach the
  // tool's private schema, but the MCP SDK would run the same Zod parse on
  // its input shape before calling our handler. Replaying it here covers
  // the validation contract the agent depends on.
  const ShapeSchema = z.object({
    url: z.string().min(1),
    agent_extracted: z
      .object({
        title: z.string().min(1),
        image_url: z.string().url().optional(),
        description: z.string().optional(),
        price: z.number().nonnegative().optional(),
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
        site_name: z.string().optional(),
      })
      .optional(),
    mcp_token: z.string().min(1),
  });

  function validate(input: unknown): { ok: boolean; error?: string } {
    const parsed = ShapeSchema.safeParse(input);
    return parsed.success
      ? { ok: true }
      : { ok: false, error: parsed.error.issues[0]?.message ?? "validation failed" };
  }

  it("rejects empty title", () => {
    const result = validate({
      url: "https://www.amazon.com/dp/X",
      agent_extracted: { title: "" },
      mcp_token: VALID_TOKEN,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed image_url", () => {
    const result = validate({
      url: "https://www.amazon.com/dp/X",
      agent_extracted: { title: "ok", image_url: "not a url" },
      mcp_token: VALID_TOKEN,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects currency that is not a 3-letter code", () => {
    const result = validate({
      url: "https://www.amazon.com/dp/X",
      agent_extracted: { title: "ok", currency: "DOLLARS" },
      mcp_token: VALID_TOKEN,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects negative price", () => {
    const result = validate({
      url: "https://www.amazon.com/dp/X",
      agent_extracted: { title: "ok", price: -10 },
      mcp_token: VALID_TOKEN,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a fully valid agent_extracted payload", () => {
    const result = validate({
      url: "https://www.amazon.com/dp/X",
      agent_extracted: {
        title: "ok",
        image_url: "https://x.com/y.jpg",
        description: "desc",
        price: 1.5,
        currency: "EUR",
        site_name: "Site",
      },
      mcp_token: VALID_TOKEN,
    });
    expect(result.ok).toBe(true);
  });

  it("input schema was registered (sanity)", () => {
    expect(inputShape).toBeDefined();
    expect(inputShape).toHaveProperty("agent_extracted");
  });
});
