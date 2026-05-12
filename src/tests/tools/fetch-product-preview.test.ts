/**
 * Tests for src/tools/fetch-product-preview.ts — registerFetchProductPreviewTool
 *
 * Mocks DB / rate-limit / config, and stubs global fetch so we never hit the
 * network. Each test captures the registered handler from a fake McpServer and
 * invokes it directly.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  logTransaction: vi.fn(),
  getCachedProductPreview: vi.fn(),
  cacheProductPreview: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

// DEV_MODE is read once at module load by config.ts; toggle it per-test via
// the mocked module export and re-import the tool inside each test that
// needs a different value.
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

const mockServer = { tool: vi.fn() };

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (_name: string, _desc: string, _schema: any, h: any) => {
      handler = h;
    }
  );
  registerFetchProductPreviewTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(logTransaction).mockReset();

  configState.DEV_MODE = false;
  configState.emergencyStop = false;

  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(logTransaction).mockResolvedValue(undefined);
  // Cache miss by default — individual tests override when they want a hit.
  vi.mocked(getCachedProductPreview).mockReset();
  vi.mocked(cacheProductPreview).mockReset();
  vi.mocked(getCachedProductPreview).mockResolvedValue(null);
  vi.mocked(cacheProductPreview).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Response-like object with a streaming body for readBodyCapped. */
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

describe("fetch_product_preview — DEV mode", () => {
  it("returns simulated preview without hitting fetch or auth", async () => {
    configState.DEV_MODE = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/\[DEV MODE\]/);
    expect(result.content[0].text).toMatch(/Sony WH-1000XM5/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(getUserByMcpToken)).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Input / URL validation
// ---------------------------------------------------------------------------

describe("fetch_product_preview — URL validation", () => {
  it("rejects a malformed URL", async () => {
    const result = await handler!({
      url: "not-a-url",
      mcp_token: VALID_TOKEN,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not well-formed/i);
  });

  it("rejects file:// scheme", async () => {
    const result = await handler!({
      url: "file:///etc/passwd",
      mcp_token: VALID_TOKEN,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unsupported protocol/i);
  });

  it("rejects localhost (SSRF)", async () => {
    const result = await handler!({
      url: "http://localhost:8080/admin",
      mcp_token: VALID_TOKEN,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/private.*host/i);
  });

  it("rejects 127.0.0.1 (SSRF)", async () => {
    const result = await handler!({
      url: "http://127.0.0.1/",
      mcp_token: VALID_TOKEN,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/private.*host/i);
  });

  it("rejects RFC1918 private IPs (10.x, 192.168.x, 172.16-31.x)", async () => {
    for (const url of [
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://169.254.169.254/",
    ]) {
      const result = await handler!({ url, mcp_token: VALID_TOKEN });
      expect(result.isError, `expected ${url} to be rejected`).toBe(true);
      expect(result.content[0].text).toMatch(/private.*host/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Successful parses
// ---------------------------------------------------------------------------

describe("fetch_product_preview — OpenGraph parsing", () => {
  it("extracts og:* and product:price:* fields", async () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Sony WH-1000XM5 Wireless Headphones" />
          <meta property="og:image" content="https://example.com/sony.jpg" />
          <meta property="og:description" content="Industry-leading noise cancellation." />
          <meta property="og:site_name" content="Amazon.com" />
          <meta property="product:price:amount" content="399.99" />
          <meta property="product:price:currency" content="USD" />
          <title>Sony XM5 — Amazon</title>
        </head>
        <body>...</body>
      </html>
    `;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("PRODUCT PREVIEW");
    expect(text).toContain("Sony WH-1000XM5 Wireless Headphones");
    expect(text).toContain("https://example.com/sony.jpg");
    expect(text).toContain("Industry-leading noise cancellation");
    expect(text).toContain("Amazon.com");
    expect(text).toContain("399.99");
    expect(text).toContain("USD");

    // logTransaction audit row recorded.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        service: "www.amazon.com",
        status: "success",
        amountUsd: 0,
        transactionType: "preview_fetch",
      })
    );
  });

  it("decodes HTML entities in meta content", async () => {
    const html = `<meta property="og:title" content="Tom &amp; Jerry — Bo&#39;s Run" />`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await handler!({
      url: "https://example.com/p",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.content[0].text).toContain("Tom & Jerry");
    expect(result.content[0].text).toContain("Bo's Run");
  });
});

describe("fetch_product_preview — fallback to <title>", () => {
  it("uses <title> when no og:title is present", async () => {
    const html = `
      <html>
        <head>
          <title>Generic Product Page</title>
          <meta name="description" content="A vanilla page without OpenGraph." />
          <meta name="twitter:image" content="https://example.com/tw.jpg" />
        </head>
      </html>
    `;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await handler!({
      url: "https://example.com/p",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Generic Product Page");
    expect(result.content[0].text).toContain("A vanilla page without OpenGraph");
    expect(result.content[0].text).toContain("https://example.com/tw.jpg");
  });

  it("falls back to the hostname when nothing is parseable", async () => {
    const html = `<html><head></head><body>no metadata</body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await handler!({
      url: "https://example.com/p",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Title: example.com");
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("fetch_product_preview — timeout", () => {
  it("returns a timeout error when fetch is aborted", async () => {
    // Simulate AbortController firing inside fetch.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      const e = new Error("The operation was aborted.");
      e.name = "AbortError";
      return Promise.reject(e);
    }));

    const result = await handler!({
      url: "https://slow.example.com/",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out/i);
  });

  it("surfaces upstream non-2xx responses as an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } })
    ));

    const result = await handler!({
      url: "https://example.com/missing",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/HTTP 404/);
  });

  it("rejects non-HTML content types", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("PDF binary…", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })
    ));

    const result = await handler!({
      url: "https://example.com/file.pdf",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/content-type/i);
  });
});

// ---------------------------------------------------------------------------
// Bait / decoy detection (HTTP 200 with generic placeholder content)
// ---------------------------------------------------------------------------

describe("fetch_product_preview — bait page detection", () => {
  it("treats Amazon decoy (title=Amazon, share-icons image) as bot-blocked", async () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Amazon" />
          <meta property="og:image" content="https://m.media-amazon.com/images/G/01/social/share-icons/previewdoh-share-img._CB1198675309_.png" />
          <meta property="og:description" content="Amazon" />
        </head>
        <body></body>
      </html>
    `;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("SCRAPING BLOCKED");
    expect(result.content[0].text).toContain("www.amazon.com");
    // Critical: do NOT cache the decoy.
    expect(vi.mocked(cacheProductPreview)).not.toHaveBeenCalled();
  });

  it("treats title=hostname + description=hostname as bot-blocked", async () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Walmart" />
          <meta property="og:description" content="Walmart" />
        </head>
        <body></body>
      </html>
    `;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await handler!({
      url: "https://www.walmart.com/ip/123456",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("SCRAPING BLOCKED");
    expect(vi.mocked(cacheProductPreview)).not.toHaveBeenCalled();
  });

  it("returns a real PRODUCT PREVIEW when the page carries genuine OG data", async () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Sony WH-1000XM5" />
          <meta property="og:image" content="https://m.media-amazon.com/images/I/61yIzVS4r-L._AC_SL1500_.jpg" />
          <meta property="og:description" content="Industry-leading noise cancellation." />
        </head>
      </html>
    `;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await handler!({
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("PRODUCT PREVIEW");
    expect(result.content[0].text).toContain("Sony WH-1000XM5");
    expect(result.content[0].text).not.toContain("SCRAPING BLOCKED");
    expect(vi.mocked(cacheProductPreview)).toHaveBeenCalledTimes(1);
  });
});
