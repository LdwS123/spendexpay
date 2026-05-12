/**
 * Tests for the shopping-experience upgrade to `request_user_consent`.
 *
 * Validates the variant + quantity contract the widget consumes:
 *   - The tool accepts a `product_variants` array (per-axis options) plus
 *     optional `min_quantity`, `max_quantity`, and `base_price_usd` fields.
 *   - The JSON blob the widget reads includes those fields verbatim so the
 *     vanilla-JS widget can render chips, a quantity picker, and a live
 *     total computed off `base_price_usd + selected.price_delta_usd`.
 *   - The markdown fallback lists the variants (axis + default + others)
 *     and a quantity line when `max_quantity > 1`, so non-widget hosts
 *     still surface the shopping context.
 *   - Validation: every axis must have a non-empty `options` array; a
 *     missing `axis` or empty options is rejected by the input schema.
 *   - Backward compat: omitting variants/quantity keeps the legacy
 *     markdown/JSON shape unchanged.
 *
 * Every I/O dependency is mocked, exactly like the widget test next door.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must precede any import of the modules under test.
// ---------------------------------------------------------------------------

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  getOrCreateConsentPreferences: vi.fn(),
  createConsentRequest: vi.fn(),
  getMonthlySpendUsd: vi.fn(),
  getRulesForUser: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("../../config.js", () => {
  const cfg = {
    emergencyStop: false,
    dashboardUrl: null as string | null,
  };
  return { config: cfg, DEV_MODE: false };
});

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  getUserByMcpToken,
  getOrCreateConsentPreferences,
  createConsentRequest,
  getMonthlySpendUsd,
  getRulesForUser,
  type ConsentPreferences,
  type ConsentRequestRecord,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import {
  registerRequestConsentTool,
  RequestConsentInput,
} from "../../tools/request-consent.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "c".repeat(32);
const CONSENT_ID = "33333333-3333-3333-3333-333333333333";
const JSON_MARKER = "<!--SPENDEX_CONSENT_JSON-->";

const MOCK_USER = {
  id: "user_var",
  email: "carol@example.com",
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
  max_auto_charge_usd: 1000,
};

const ALWAYS_ASK: ConsentPreferences = {
  user_id: MOCK_USER.id,
  default_mode: "always_ask",
  auto_below_threshold_usd: null,
  trusted_services: [],
  notification_channels: [],
  telegram_chat_id: null,
  email_for_consent: null,
};

const BASE_INPUT = {
  action: "pay_for_service" as const,
  service: "amazon",
  context: "Buy Sony WH-1000XM5 headphones",
  amount_usd: 399,
  mcp_token: VALID_TOKEN,
};

const SAMPLE_VARIANTS = [
  {
    axis: "color",
    default_value: "blue",
    options: [
      { name: "Black", value: "black", price_delta_usd: 0 },
      { name: "Silver", value: "silver", price_delta_usd: 0 },
      {
        name: "Midnight Blue",
        value: "blue",
        price_delta_usd: 20,
        image_url: "https://cdn.example.com/sony-blue.png",
      },
    ],
  },
  {
    axis: "size",
    default_value: "M",
    options: [
      { name: "S", value: "S" },
      { name: "M", value: "M" },
      { name: "L", value: "L", available: false },
      { name: "XL", value: "XL" },
    ],
  },
];

function pendingRow(
  overrides: Partial<ConsentRequestRecord> = {}
): ConsentRequestRecord {
  return {
    id: CONSENT_ID,
    user_id: MOCK_USER.id,
    action: "pay_for_service",
    service: "amazon",
    amount_usd: 399,
    context: { description: "Buy Sony WH-1000XM5 headphones" },
    options: ["approve", "decline"],
    status: "pending",
    decision: null,
    decision_metadata: null,
    decision_made_at: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Handler capture
// ---------------------------------------------------------------------------

type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

let handler: ((input: Record<string, unknown>) => Promise<HandlerResult>) | undefined;

const mockServer = { registerTool: vi.fn() };

beforeAll(() => {
  mockServer.registerTool.mockImplementation(
    (
      _name: string,
      _cfg: Record<string, unknown>,
      h: (input: Record<string, unknown>) => Promise<HandlerResult>
    ) => {
      handler = h;
      return { enable: () => {}, disable: () => {}, update: () => {}, remove: () => {} };
    }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerRequestConsentTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(getOrCreateConsentPreferences).mockReset();
  vi.mocked(createConsentRequest).mockReset();
  vi.mocked(getMonthlySpendUsd).mockReset();
  vi.mocked(getRulesForUser).mockReset();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config as any).emergencyStop = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config as any).dashboardUrl = null;

  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getOrCreateConsentPreferences).mockResolvedValue(ALWAYS_ASK);
  vi.mocked(createConsentRequest).mockResolvedValue(pendingRow());
  vi.mocked(getMonthlySpendUsd).mockResolvedValue(0);
  vi.mocked(getRulesForUser).mockResolvedValue([]);
});

function extractWidgetJson(text: string): Record<string, unknown> {
  const idx = text.indexOf(JSON_MARKER);
  expect(idx).toBeGreaterThanOrEqual(0);
  const blob = text.slice(idx + JSON_MARKER.length).trim();
  return JSON.parse(blob) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Schema acceptance
// ---------------------------------------------------------------------------

describe("request_user_consent — product_variants schema", () => {
  it("accepts a fully-populated variants array without error", async () => {
    const result = await handler!({
      ...BASE_INPUT,
      product_variants: SAMPLE_VARIANTS,
      min_quantity: 1,
      max_quantity: 5,
      base_price_usd: 399,
    });
    expect(result.isError).toBeUndefined();
  });

  // The MCP server runs RequestConsentInput before our handler executes, so
  // these schema-rejection cases assert on the schema directly. A failing
  // parse stops the request before it reaches createConsentRequest in
  // production; here we just check `.success` to keep the test offline.
  it("rejects a variant with an empty options array", () => {
    const parsed = RequestConsentInput.safeParse({
      ...BASE_INPUT,
      product_variants: [{ axis: "color", options: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a variant missing its axis label", () => {
    const parsed = RequestConsentInput.safeParse({
      ...BASE_INPUT,
      product_variants: [
        { options: [{ name: "Black", value: "black" }] },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-positive max_quantity", () => {
    const parsed = RequestConsentInput.safeParse({
      ...BASE_INPUT,
      max_quantity: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a variant option missing its required name/value pair", () => {
    const parsed = RequestConsentInput.safeParse({
      ...BASE_INPUT,
      // Missing `name` on the option object — schema requires both.
      product_variants: [
        { axis: "color", options: [{ value: "black" }] },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSON payload (widget) contract
// ---------------------------------------------------------------------------

describe("request_user_consent — variants land in the widget JSON payload", () => {
  it("propagates product_variants verbatim to the JSON blob", async () => {
    const result = await handler!({
      ...BASE_INPUT,
      product_variants: SAMPLE_VARIANTS,
      min_quantity: 1,
      max_quantity: 5,
      base_price_usd: 399,
    });

    const json = extractWidgetJson(result.content[0]!.text);
    expect(json.product_variants).toEqual(SAMPLE_VARIANTS);
    expect(json.min_quantity).toBe(1);
    expect(json.max_quantity).toBe(5);
    expect(json.base_price_usd).toBe(399);
  });

  it("falls back to amount_usd as base_price_usd when not specified", async () => {
    const result = await handler!({
      ...BASE_INPUT,
      product_variants: SAMPLE_VARIANTS,
    });

    const json = extractWidgetJson(result.content[0]!.text);
    // base_price_usd was omitted, so the widget should receive amount_usd
    // as the unit price for live total computation.
    expect(json.base_price_usd).toBe(399);
    // Default min/max quantity is 1, suppressing the picker.
    expect(json.min_quantity).toBe(1);
    expect(json.max_quantity).toBe(1);
  });

  it("preserves backward compat: variants are null when omitted", async () => {
    const result = await handler!(BASE_INPUT);

    const json = extractWidgetJson(result.content[0]!.text);
    expect(json.product_variants).toBeNull();
    expect(json.min_quantity).toBe(1);
    expect(json.max_quantity).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Markdown fallback
// ---------------------------------------------------------------------------

describe("request_user_consent — markdown fallback lists variants", () => {
  it("lists each axis with its default + the other options", async () => {
    const result = await handler!({
      ...BASE_INPUT,
      product_variants: SAMPLE_VARIANTS,
      min_quantity: 1,
      max_quantity: 5,
      base_price_usd: 399,
    });

    const text = result.content[0]!.text;
    // The "Variants:" section is the new contract for non-widget hosts.
    expect(text).toContain("Variants:");
    // Axis lines surface the default + the rest of the options.
    expect(text).toMatch(/color: Midnight Blue \(default\).*Black.*Silver/);
    expect(text).toMatch(/size: M \(default\).*S.*L.*XL/);
  });

  it("renders a quantity line only when max_quantity > 1", async () => {
    const withPicker = await handler!({
      ...BASE_INPUT,
      product_variants: SAMPLE_VARIANTS,
      max_quantity: 5,
      base_price_usd: 399,
    });
    expect(withPicker.content[0]!.text).toContain("Quantity: 1 (max 5)");

    vi.mocked(createConsentRequest).mockResolvedValue(pendingRow());
    const noPicker = await handler!({
      ...BASE_INPUT,
      product_variants: SAMPLE_VARIANTS,
      base_price_usd: 399,
    });
    expect(noPicker.content[0]!.text).not.toContain("Quantity:");
  });

  it("renders the computed default total when variants modify price", async () => {
    const result = await handler!({
      ...BASE_INPUT,
      product_variants: SAMPLE_VARIANTS,
      base_price_usd: 399,
    });
    // Default color = Midnight Blue (+$20), default size = M (+$0), qty 1
    // → $419.00 expected on the Total line.
    expect(result.content[0]!.text).toContain("Total: $419.00");
  });

  it("does not emit a Variants block when none are supplied", async () => {
    const result = await handler!(BASE_INPUT);
    expect(result.content[0]!.text).not.toContain("Variants:");
    expect(result.content[0]!.text).not.toContain("Total: $");
  });
});
