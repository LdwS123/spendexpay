/**
 * Tests for src/tools/search-products.ts — registerSearchProductsTool.
 *
 * Mocks DB / rate-limit / config the same way fetch-product-preview.test.ts
 * does so the two suites stay easy to read side-by-side. Each test captures
 * the registered handler from a fake McpServer and invokes it directly —
 * no real network, no real Supabase.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../../lib/db.js", () => ({
  logTransaction: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("../../lib/tool-auth.js", () => ({
  authenticateToolCall: vi.fn(),
}));

// DEV_MODE is read once at module load by config.ts; toggle it per-test via
// the mocked module export.
const configState = { DEV_MODE: false, emergencyStop: false };
vi.mock("../../config.js", () => ({
  get DEV_MODE() { return configState.DEV_MODE; },
  config: {
    get emergencyStop() { return configState.emergencyStop; },
  },
}));

import { logTransaction } from "../../lib/db.js";
import { authenticateToolCall } from "../../lib/tool-auth.js";
import { registerSearchProductsTool } from "../../tools/search-products.js";

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
  registerSearchProductsTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(logTransaction).mockReset();
  vi.mocked(authenticateToolCall).mockReset();

  configState.DEV_MODE = false;
  configState.emergencyStop = false;

  vi.mocked(logTransaction).mockResolvedValue(undefined);
  vi.mocked(authenticateToolCall).mockResolvedValue({ ok: true, user: MOCK_USER as any });
});

// ---------------------------------------------------------------------------
// DEV mode
// ---------------------------------------------------------------------------

describe("search_products — DEV mode", () => {
  it("returns three simulated results without hitting fetch or auth", async () => {
    configState.DEV_MODE = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handler!({
      merchant: "amazon",
      query: "sony noise cancelling headphones",
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toMatch(/\[DEV MODE\]/);
    expect(text).toMatch(/SEARCH RESULTS/);
    expect(text).toContain("Sony WH-1000XM5");
    expect(text).toContain("Bose QuietComfort 45");
    expect(text).toContain("AirPods Max");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(authenticateToolCall)).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("filters DEV results by max_price_usd", async () => {
    configState.DEV_MODE = true;

    const result = await handler!({
      merchant: "amazon",
      query: "sony",
      max_price_usd: 300,
      mcp_token: VALID_TOKEN,
    });

    const text = result.content[0].text;
    // Bose ($279) stays, Sony ($399.99) and AirPods Max ($549) are filtered out.
    expect(text).toContain("Bose QuietComfort 45");
    expect(text).not.toContain("Sony WH-1000XM5");
    expect(text).not.toContain("AirPods Max");
  });
});

// ---------------------------------------------------------------------------
// Input validation (zod-level)
// ---------------------------------------------------------------------------

describe("search_products — input validation", () => {
  it("rejects an empty query (zod min(1))", () => {
    // Zod schemas are exposed via `inputShape` — validate `query` directly.
    const queryShape = inputShape!["query"] as any;
    const parsed = queryShape.safeParse("");
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty merchant (zod min(1))", () => {
    const merchantShape = inputShape!["merchant"] as any;
    const parsed = merchantShape.safeParse("");
    expect(parsed.success).toBe(false);
  });

  it("rejects negative max_price_usd (zod positive)", () => {
    const priceShape = inputShape!["max_price_usd"] as any;
    expect(priceShape.safeParse(-1).success).toBe(false);
    expect(priceShape.safeParse(0).success).toBe(false);
    expect(priceShape.safeParse(1).success).toBe(true);
  });

  it("rejects non-integer max_results", () => {
    const mrShape = inputShape!["max_results"] as any;
    expect(mrShape.safeParse(1.5).success).toBe(false);
    expect(mrShape.safeParse(5).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agent_extracted path
// ---------------------------------------------------------------------------

describe("search_products — agent_extracted results", () => {
  it("validates and formats supplied rows", async () => {
    const result = await handler!({
      merchant: "amazon",
      query: "sony headphones",
      agent_extracted: {
        results: [
          {
            url: "https://www.amazon.com/dp/B09XS7JWHH",
            title: "Sony WH-1000XM5",
            image_url: "https://example.com/sony.jpg",
            price_usd: 399.99,
            rating: 4.6,
            review_count: 12_000,
            prime_eligible: true,
          },
          {
            url: "https://www.amazon.com/dp/B098FKXT8L",
            title: "Bose QuietComfort 45",
            price_usd: 278,
            rating: 4.7,
            review_count: 45_000,
          },
        ],
      },
      mcp_token: VALID_TOKEN,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("SEARCH RESULTS - top 2");
    expect(text).toContain("Sony WH-1000XM5");
    expect(text).toContain("$399.99");
    expect(text).toContain("Bose QuietComfort 45");
    expect(text).toContain("$278");
    expect(text).toContain("[Prime]");

    // Audit log captures the agent-extracted variant.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        service: "amazon",
        status: "success",
        amountUsd: 0,
        transactionType: "product_search_via_agent",
      })
    );
  });

  it("filters agent results by max_price_usd", async () => {
    const result = await handler!({
      merchant: "amazon",
      query: "sony",
      max_price_usd: 300,
      agent_extracted: {
        results: [
          { url: "https://www.amazon.com/dp/A", title: "Cheap", price_usd: 199 },
          { url: "https://www.amazon.com/dp/B", title: "Expensive", price_usd: 399 },
        ],
      },
      mcp_token: VALID_TOKEN,
    });

    const text = result.content[0].text;
    expect(text).toContain("Cheap");
    expect(text).not.toContain("Expensive");
  });

  it("caps results at MAX_RESULTS_CAP (20) even when more are supplied", async () => {
    const overflow = Array.from({ length: 30 }, (_, i) => ({
      url: `https://www.amazon.com/dp/X${i}`,
      title: `Item ${i}`,
      price_usd: 10 + i,
    }));

    // Request 50 — should be silently capped to 20.
    const result = await handler!({
      merchant: "amazon",
      query: "stuff",
      max_results: 50,
      agent_extracted: { results: overflow },
      mcp_token: VALID_TOKEN,
    });

    const text = result.content[0].text;
    expect(text).toContain("SEARCH RESULTS - top 20");
    expect(text).toContain("Item 0");
    expect(text).toContain("Item 19");
    expect(text).not.toContain("Item 20");
  });

  it("rejects an empty agent_extracted.results array (zod min(1))", () => {
    const aeShape = inputShape!["agent_extracted"] as any;
    const parsed = aeShape.safeParse({ results: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects malformed url in agent rows", () => {
    const aeShape = inputShape!["agent_extracted"] as any;
    const parsed = aeShape.safeParse({
      results: [{ url: "not-a-url", title: "Whatever" }],
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server scrape behaviour — Amazon is on the BLOCKED_MERCHANTS list so the
// tool MUST short-circuit straight to SCRAPING BLOCKED without ever calling
// fetch(). The captured fetch spy proves we did not waste a round-trip.
// ---------------------------------------------------------------------------

describe("search_products — Amazon goes straight to SCRAPING BLOCKED", () => {
  it("returns the agent-fallback instruction without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handler!({
      merchant: "amazon",
      query: "sony noise cancelling",
      mcp_token: VALID_TOKEN,
    });
    vi.unstubAllGlobals();

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("SCRAPING BLOCKED");
    expect(text).toContain("amazon");
    expect(text).toContain("agent_extracted");
    expect(fetchSpy).not.toHaveBeenCalled();

    // Audit log records the blocked handoff.
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        service: "amazon",
        status: "success",
        transactionType: "product_search",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Auth failure surfaces
// ---------------------------------------------------------------------------

describe("search_products — auth failures bubble up", () => {
  it("returns the auth response without touching anything else", async () => {
    vi.mocked(authenticateToolCall).mockResolvedValueOnce({
      ok: false,
      response: {
        content: [{ type: "text", text: "Invalid MCP token format." }],
        isError: true,
      } as any,
    });

    const result = await handler!({
      merchant: "amazon",
      query: "anything",
      mcp_token: "bogus",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid mcp token/i);
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});
