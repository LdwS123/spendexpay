/**
 * Tests for src/tools/request-consent.ts — registerRequestConsentTool
 *
 * Every I/O dependency is mocked (DB, rate-limit, dashboard notification
 * `fetch`) so the suite runs entirely offline. The MCP server is faked with
 * a minimal { tool } stub that captures the handler so we can drive it
 * directly and assert on the returned text.
 *
 * Coverage:
 *   - DEV mode short-circuits with an auto-approved response
 *   - Auth fails on a missing/malformed token (no DB roundtrip)
 *   - `auto_below_threshold` preference auto-approves without inserting a
 *     consent_requests row
 *   - `auto_for_trusted_services` preference auto-approves for a trusted
 *     service slug
 *   - A non-auto-approved request returns IMMEDIATELY with a structured
 *     prompt that includes the consent_id and option list — no polling
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must precede any import of the modules under test.
// ---------------------------------------------------------------------------

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  getOrCreateConsentPreferences: vi.fn(),
  createConsentRequest: vi.fn(),
  // The widget-payload path snapshots the user's monthly spend + rules into
  // the JSON blob. These are best-effort lookups; the test default returns
  // empty values so the existing assertions keep matching the markdown text.
  getMonthlySpendUsd: vi.fn(),
  getRulesForUser: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("../../config.js", () => {
  const cfg = {
    emergencyStop: false,
    // No dashboard URL — disables the fire-and-forget notification path so
    // the tool never reaches for global fetch under test.
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
import { registerRequestConsentTool } from "../../tools/request-consent.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "a".repeat(32);

const MOCK_USER = {
  id: "user_rc",
  email: "alice@example.com",
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
  context: "Deploy 'my-app' to production",
  amount_usd: 25,
  mcp_token: VALID_TOKEN,
};

const CONSENT_ID = "11111111-1111-1111-1111-111111111111";

function pendingRow(overrides: Partial<ConsentRequestRecord> = {}): ConsentRequestRecord {
  return {
    id: CONSENT_ID,
    user_id: MOCK_USER.id,
    action: "pay_for_service",
    service: "vercel",
    amount_usd: 25,
    context: { description: "Deploy 'my-app' to production" },
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
let capturedToolConfig: Record<string, unknown> | undefined;

// `registerRequestConsentTool` now uses `registerAppTool` from
// @modelcontextprotocol/ext-apps, which calls `server.registerTool(name,
// config, handler)`. The mock captures both the handler (so we can drive
// it) and the config (so we can assert on `_meta.ui.resourceUri`).
const mockServer = { registerTool: vi.fn() };

beforeAll(() => {
  mockServer.registerTool.mockImplementation(
    (
      _name: string,
      config: Record<string, unknown>,
      h: (input: Record<string, unknown>) => Promise<HandlerResult>
    ) => {
      capturedToolConfig = config;
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

  // Happy-path defaults — individual tests override as needed.
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getOrCreateConsentPreferences).mockResolvedValue(ALWAYS_ASK);
  vi.mocked(createConsentRequest).mockResolvedValue(pendingRow());
  // Rule snapshot defaults — empty state so the JSON blob renders cleanly
  // without affecting the markdown assertions.
  vi.mocked(getMonthlySpendUsd).mockResolvedValue(0);
  vi.mocked(getRulesForUser).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// DEV mode
// ---------------------------------------------------------------------------

describe("registerRequestConsentTool — DEV mode", () => {
  it("returns an auto-approved response without touching DB or rate limit", async () => {
    vi.resetModules();

    vi.doMock("../../config.js", () => ({
      config: { emergencyStop: false, dashboardUrl: null },
      DEV_MODE: true,
    }));
    vi.doMock("../../lib/db.js", () => ({
      getUserByMcpToken: vi.fn(),
      getOrCreateConsentPreferences: vi.fn(),
      createConsentRequest: vi.fn(),
      getMonthlySpendUsd: vi.fn(),
      getRulesForUser: vi.fn(),
    }));
    vi.doMock("../../lib/rate-limit.js", () => ({ checkRateLimit: vi.fn() }));

    const { registerRequestConsentTool: devRegister } = await import(
      "../../tools/request-consent.js"
    );

    let devHandler:
      | ((input: Record<string, unknown>) => Promise<HandlerResult>)
      | undefined;
    const devServer = {
      registerTool: (
        _n: string,
        _config: Record<string, unknown>,
        h: (input: Record<string, unknown>) => Promise<HandlerResult>
      ) => {
        devHandler = h;
        return { enable: () => {}, disable: () => {}, update: () => {}, remove: () => {} };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    devRegister(devServer as any);

    const result = await devHandler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/DEV MODE/);
    expect(text).toMatch(/CONSENT APPROVED/);
    expect(text).toMatch(/Decision: approve/);

    // None of the production helpers must have been touched.
    const { getUserByMcpToken: realGet } = await import("../../lib/db.js");
    expect(vi.mocked(realGet)).not.toHaveBeenCalled();

    vi.resetModules();
    vi.doUnmock("../../config.js");
    vi.doUnmock("../../lib/db.js");
    vi.doUnmock("../../lib/rate-limit.js");
  });
});

// ---------------------------------------------------------------------------
// Auth failures
// ---------------------------------------------------------------------------

describe("registerRequestConsentTool — auth", () => {
  it("fails on a malformed MCP token without touching the DB", async () => {
    const result = await handler!({
      ...BASE_INPUT,
      mcp_token: "not-a-real-token",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid MCP token format/);
    expect(vi.mocked(getUserByMcpToken)).not.toHaveBeenCalled();
    expect(vi.mocked(createConsentRequest)).not.toHaveBeenCalled();
  });

  it("fails when getUserByMcpToken returns null (unknown token)", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue(null);

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid or expired MCP token/);
    expect(vi.mocked(createConsentRequest)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto-approve paths
// ---------------------------------------------------------------------------

describe("registerRequestConsentTool — auto-approve below threshold", () => {
  it("returns APPROVED (auto) without creating a consent_requests row", async () => {
    vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
      ...ALWAYS_ASK,
      default_mode: "auto_below_threshold",
      auto_below_threshold_usd: 50,
    });

    const result = await handler!({ ...BASE_INPUT, amount_usd: 10 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/CONSENT APPROVED/);
    expect(text).toMatch(/Decision: approve/);
    expect(text).toMatch(/Auto-approved by policy: auto_below_threshold/);

    expect(vi.mocked(createConsentRequest)).not.toHaveBeenCalled();
  });

  it("does NOT auto-approve when the amount equals the threshold", async () => {
    // Strict < — equality is treated as "ask".
    vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
      ...ALWAYS_ASK,
      default_mode: "auto_below_threshold",
      auto_below_threshold_usd: 50,
    });
    vi.mocked(createConsentRequest).mockResolvedValue(pendingRow());

    const result = await handler!({ ...BASE_INPUT, amount_usd: 50 });

    expect(result.isError).toBeUndefined();
    expect(vi.mocked(createConsentRequest)).toHaveBeenCalledTimes(1);
    expect(result.content[0]!.text).toMatch(/CONSENT NEEDED/);
  });
});

describe("registerRequestConsentTool — auto-approve trusted services", () => {
  it("auto-approves when service is in the user's trusted list", async () => {
    vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
      ...ALWAYS_ASK,
      default_mode: "auto_for_trusted_services",
      trusted_services: ["vercel", "modal"],
    });

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/CONSENT APPROVED/);
    expect(text).toMatch(/Auto-approved by policy: auto_for_trusted_services/);

    expect(vi.mocked(createConsentRequest)).not.toHaveBeenCalled();
  });

  it("falls through to a prompt when service is NOT trusted", async () => {
    vi.mocked(getOrCreateConsentPreferences).mockResolvedValue({
      ...ALWAYS_ASK,
      default_mode: "auto_for_trusted_services",
      trusted_services: ["modal"],
    });

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    expect(vi.mocked(createConsentRequest)).toHaveBeenCalledTimes(1);
    expect(result.content[0]!.text).toMatch(/CONSENT NEEDED/);
  });
});

// ---------------------------------------------------------------------------
// Inline prompt return path
// ---------------------------------------------------------------------------

describe("registerRequestConsentTool — inline prompt", () => {
  it("returns CONSENT NEEDED immediately after creating the row", async () => {
    vi.mocked(createConsentRequest).mockResolvedValue(pendingRow());

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/^CONSENT NEEDED/);
    expect(text).toContain(`Consent ID: ${CONSENT_ID}`);
    expect(text).toMatch(/submit_consent_decision/);
    expect(text).toMatch(/Wait for the user's actual response/);
    expect(vi.mocked(createConsentRequest)).toHaveBeenCalledTimes(1);
  });

  it("includes default signup options when action='signup_to_service'", async () => {
    vi.mocked(createConsentRequest).mockResolvedValue(
      pendingRow({
        action: "signup_to_service",
        options: [
          "auto_create_dedicated_email",
          "auto_create_my_email",
          "connect_existing",
          "decline",
        ],
      })
    );

    const result = await handler!({
      ...BASE_INPUT,
      action: "signup_to_service",
      amount_usd: undefined,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/^CONSENT NEEDED/);
    expect(text).toContain("auto_create_dedicated_email");
    expect(text).toContain("auto_create_my_email");
    expect(text).toContain("connect_existing");
    expect(text).toContain("decline");

    // Default options for signup must be passed through to createConsentRequest.
    expect(vi.mocked(createConsentRequest)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "signup_to_service",
        options: [
          "auto_create_dedicated_email",
          "auto_create_my_email",
          "connect_existing",
          "decline",
        ],
      })
    );
  });

  it("surfaces an error if createConsentRequest throws", async () => {
    vi.mocked(createConsentRequest).mockRejectedValue(new Error("db down"));

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Could not create consent request/);
  });
});
