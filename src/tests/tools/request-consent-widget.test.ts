/**
 * Tests for the MCP UI widget integration on `request_user_consent`.
 *
 * Validates the contract the widget consumes:
 *   - The tool is registered via `registerAppTool` and declares
 *     `_meta.ui.resourceUri` pointing at the consent-dialog widget URI.
 *   - The handler's text payload is a hybrid markdown + JSON blob: the
 *     markdown prefix is what non-widget clients see (the legacy contract),
 *     the JSON after the `<!--SPENDEX_CONSENT_JSON-->` marker is what the
 *     widget parses to populate the dialog.
 *   - The JSON blob carries every field the widget needs to render: consent
 *     ID, action, service, amount/currency, description, monthly spent + cap,
 *     per-transaction cap, MCP token (so the widget can call back into
 *     submit_consent_decision), the available options, and the expiry.
 *
 * As with the other consent tests, every I/O dependency is mocked and the
 * MCP server is a minimal `{ registerTool }` stub that captures the config
 * + handler so we can drive them directly.
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
  type SpendexRule,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import {
  registerRequestConsentTool,
  CONSENT_DIALOG_RESOURCE_URI,
} from "../../tools/request-consent.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "b".repeat(32);
const CONSENT_ID = "22222222-2222-2222-2222-222222222222";

const MOCK_USER = {
  id: "user_widget",
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

const ALWAYS_ASK: ConsentPreferences = {
  user_id: MOCK_USER.id,
  default_mode: "always_ask",
  auto_below_threshold_usd: null,
  trusted_services: [],
  notification_channels: ["email"],
  telegram_chat_id: null,
  email_for_consent: null,
};

const BASE_INPUT = {
  action: "pay_for_service" as const,
  service: "vercel",
  context: "Upgrade my-app to Vercel Pro",
  amount_usd: 20,
  mcp_token: VALID_TOKEN,
};

function pendingRow(overrides: Partial<ConsentRequestRecord> = {}): ConsentRequestRecord {
  return {
    id: CONSENT_ID,
    user_id: MOCK_USER.id,
    action: "pay_for_service",
    service: "vercel",
    amount_usd: 20,
    context: { description: "Upgrade my-app to Vercel Pro" },
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

function aggregatedRule(overrides: Partial<SpendexRule> = {}): SpendexRule {
  return {
    id: "rule_1",
    user_id: MOCK_USER.id,
    service_filter: null,
    max_per_transaction_usd: 100,
    monthly_budget_usd: 500,
    allowed_services: null,
    blocked_services: null,
    active: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Handler + config capture
// ---------------------------------------------------------------------------

type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

let handler: ((input: Record<string, unknown>) => Promise<HandlerResult>) | undefined;
let capturedToolName: string | undefined;
let capturedToolConfig: Record<string, unknown> | undefined;

const mockServer = { registerTool: vi.fn() };

beforeAll(() => {
  mockServer.registerTool.mockImplementation(
    (
      name: string,
      cfg: Record<string, unknown>,
      h: (input: Record<string, unknown>) => Promise<HandlerResult>
    ) => {
      capturedToolName = name;
      capturedToolConfig = cfg;
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
  vi.mocked(getMonthlySpendUsd).mockResolvedValue(42);
  vi.mocked(getRulesForUser).mockResolvedValue([aggregatedRule()]);
});

// ---------------------------------------------------------------------------
// Registration shape
// ---------------------------------------------------------------------------

const JSON_MARKER = "<!--SPENDEX_CONSENT_JSON-->";

function extractWidgetJson(text: string): Record<string, unknown> {
  const idx = text.indexOf(JSON_MARKER);
  expect(idx).toBeGreaterThanOrEqual(0);
  const blob = text.slice(idx + JSON_MARKER.length).trim();
  return JSON.parse(blob) as Record<string, unknown>;
}

describe("request_user_consent — widget registration", () => {
  it("registers under the canonical tool name with a Spendex-branded description", () => {
    expect(capturedToolName).toBe("request_user_consent");
    expect(typeof capturedToolConfig?.description).toBe("string");
  });

  it("declares the consent-dialog widget via _meta.ui.resourceUri", () => {
    const meta = capturedToolConfig?._meta as
      | { ui?: { resourceUri?: string } }
      | undefined;
    expect(meta?.ui?.resourceUri).toBe(CONSENT_DIALOG_RESOURCE_URI);
    expect(meta?.ui?.resourceUri).toBe("ui://widgets/consent-dialog.html");
  });
});

// ---------------------------------------------------------------------------
// Hybrid payload contract
// ---------------------------------------------------------------------------

describe("request_user_consent — hybrid markdown + JSON payload", () => {
  it("returns a markdown prefix (legacy fallback) followed by a JSON blob", async () => {
    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;

    // The markdown prefix is the same contract pre-widget clients depend on.
    expect(text).toMatch(/^CONSENT NEEDED/);
    expect(text).toContain(`Consent ID: ${CONSENT_ID}`);

    // The JSON marker separates the two halves.
    expect(text).toContain(JSON_MARKER);

    // The widget's payload sits after the marker and must parse cleanly.
    const json = extractWidgetJson(text);
    expect(typeof json).toBe("object");
    expect(json).not.toBeNull();
  });

  it("populates every field the consent dialog needs to render", async () => {
    const result = await handler!(BASE_INPUT);
    const json = extractWidgetJson(result.content[0]!.text);

    // Identity + action — feeds the heading and Approve/Decline submit call.
    expect(json.consent_id).toBe(CONSENT_ID);
    expect(json.action).toBe("pay_for_service");
    expect(json.service).toBe("vercel");
    expect(json.mcp_token).toBe(VALID_TOKEN);

    // Amount block — rendered as the large currency-prefixed number.
    expect(json.amount).toBe(20);
    expect(json.currency).toBe("USD");
    expect(json.description).toBe("Upgrade my-app to Vercel Pro");

    // Rules section — pulled from getMonthlySpendUsd + getRulesForUser.
    expect(json.monthly_spent).toBe(42);
    expect(json.monthly_cap).toBe(500);
    expect(json.per_tx_cap).toBe(100);

    // Approve / Decline buttons come from the row's options list.
    expect(json.options).toEqual(["approve", "decline"]);

    // Expiry surfaces so the widget can show a countdown if needed.
    expect(typeof json.expires_at).toBe("string");
  });

  it("renders null caps when the user has no spending rules configured", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([]);
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(0);

    const result = await handler!(BASE_INPUT);
    const json = extractWidgetJson(result.content[0]!.text);

    expect(json.monthly_spent).toBe(0);
    expect(json.monthly_cap).toBeNull();
    expect(json.per_tx_cap).toBeNull();
  });

  it("does not surface a rules-lookup failure to the agent", async () => {
    // Spending-rule snapshot is decorative on the widget — a DB hiccup here
    // must NOT break the consent flow. Caps fall back to null.
    vi.mocked(getMonthlySpendUsd).mockRejectedValue(new Error("rds blip"));
    vi.mocked(getRulesForUser).mockRejectedValue(new Error("rds blip"));

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const json = extractWidgetJson(result.content[0]!.text);
    expect(json.consent_id).toBe(CONSENT_ID);
    expect(json.monthly_spent).toBeNull();
    expect(json.monthly_cap).toBeNull();
    expect(json.per_tx_cap).toBeNull();
  });

  it("carries the full options list when action='signup_to_service'", async () => {
    const signupOptions = [
      "auto_create_dedicated_email",
      "auto_create_my_email",
      "connect_existing",
      "decline",
    ];
    vi.mocked(createConsentRequest).mockResolvedValue(
      pendingRow({ action: "signup_to_service", options: signupOptions })
    );

    const result = await handler!({
      ...BASE_INPUT,
      action: "signup_to_service",
      amount_usd: undefined,
    });
    const json = extractWidgetJson(result.content[0]!.text);

    expect(json.action).toBe("signup_to_service");
    expect(json.options).toEqual(signupOptions);
    // `amount_usd` was omitted, so the widget gets an explicit null rather
    // than a phantom "0" that would mis-render the amount block.
    expect(json.amount).toBeNull();
  });

  it("does not emit the JSON blob when the request is auto-approved", async () => {
    vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
      ...ALWAYS_ASK,
      default_mode: "auto_below_threshold",
      auto_below_threshold_usd: 50,
    });

    const result = await handler!({ ...BASE_INPUT, amount_usd: 10 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/CONSENT APPROVED/);
    // Auto-approve never creates a consent_requests row, so there is nothing
    // for the widget to display — the marker must NOT appear.
    expect(text).not.toContain(JSON_MARKER);
  });
});
