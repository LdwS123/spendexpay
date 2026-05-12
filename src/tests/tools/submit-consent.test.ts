/**
 * Tests for src/tools/submit-consent.ts — registerSubmitConsentDecisionTool
 *
 * Every I/O dependency is mocked (DB, rate-limit) so the suite runs entirely
 * offline. The MCP server is faked with a minimal { tool } stub that
 * captures the handler so we can drive it directly and assert on the
 * returned text.
 *
 * Coverage:
 *   - DEV mode short-circuits with a recorded response
 *   - Auth fails on a missing/malformed token (no DB roundtrip)
 *   - Happy path: pending row + valid option → CONSENT RECORDED
 *   - "decline" routes status → declined
 *   - Rejects a decision that is NOT in the row's options
 *   - Rejects an expired row even when status is still 'pending'
 *   - Rejects an already-decided row (status !== 'pending')
 *   - Surfaces "no row updated" when recordConsentDecision returns null
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must precede any import of the modules under test.
// ---------------------------------------------------------------------------

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  getConsentRequest: vi.fn(),
  recordConsentDecision: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("../../config.js", () => {
  const cfg = { emergencyStop: false };
  return { config: cfg, DEV_MODE: false };
});

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  getUserByMcpToken,
  getConsentRequest,
  recordConsentDecision,
  type ConsentRequestRecord,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import { registerSubmitConsentDecisionTool } from "../../tools/submit-consent.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "b".repeat(32);
const CONSENT_ID = "22222222-2222-2222-2222-222222222222";

const MOCK_USER = {
  id: "user_sc",
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

function pendingRow(overrides: Partial<ConsentRequestRecord> = {}): ConsentRequestRecord {
  return {
    id: CONSENT_ID,
    user_id: MOCK_USER.id,
    action: "signup_to_service",
    service: "vercel",
    amount_usd: null,
    context: { description: "Sign up to Vercel" },
    options: [
      "auto_create_dedicated_email",
      "auto_create_my_email",
      "connect_existing",
      "decline",
    ],
    status: "pending",
    decision: null,
    decision_metadata: null,
    decision_made_at: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const BASE_INPUT = {
  consent_id: CONSENT_ID,
  decision: "auto_create_dedicated_email",
  mcp_token: VALID_TOKEN,
};

// ---------------------------------------------------------------------------
// Handler capture
// ---------------------------------------------------------------------------

type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

let handler: ((input: Record<string, unknown>) => Promise<HandlerResult>) | undefined;

const mockServer = { tool: vi.fn() };

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (
      _name: string,
      _desc: string,
      _schema: unknown,
      h: (input: Record<string, unknown>) => Promise<HandlerResult>
    ) => {
      handler = h;
    }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSubmitConsentDecisionTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(getConsentRequest).mockReset();
  vi.mocked(recordConsentDecision).mockReset();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config as any).emergencyStop = false;

  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getConsentRequest).mockResolvedValue(pendingRow());
  vi.mocked(recordConsentDecision).mockResolvedValue(
    pendingRow({
      status: "approved",
      decision: "auto_create_dedicated_email",
      decision_made_at: new Date().toISOString(),
    })
  );
});

// ---------------------------------------------------------------------------
// DEV mode
// ---------------------------------------------------------------------------

describe("registerSubmitConsentDecisionTool — DEV mode", () => {
  it("returns CONSENT RECORDED without touching DB", async () => {
    vi.resetModules();

    vi.doMock("../../config.js", () => ({
      config: { emergencyStop: false },
      DEV_MODE: true,
    }));
    vi.doMock("../../lib/db.js", () => ({
      getUserByMcpToken: vi.fn(),
      getConsentRequest: vi.fn(),
      recordConsentDecision: vi.fn(),
    }));
    vi.doMock("../../lib/rate-limit.js", () => ({ checkRateLimit: vi.fn() }));

    const { registerSubmitConsentDecisionTool: devRegister } = await import(
      "../../tools/submit-consent.js"
    );

    let devHandler:
      | ((input: Record<string, unknown>) => Promise<HandlerResult>)
      | undefined;
    const devServer = {
      tool: (
        _n: string,
        _d: string,
        _s: unknown,
        h: (input: Record<string, unknown>) => Promise<HandlerResult>
      ) => {
        devHandler = h;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    devRegister(devServer as any);

    const result = await devHandler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/DEV MODE/);
    expect(text).toMatch(/CONSENT RECORDED/);
    expect(text).toMatch(/Status: approved/);

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

describe("registerSubmitConsentDecisionTool — auth", () => {
  it("fails on a malformed MCP token without touching the DB", async () => {
    const result = await handler!({
      ...BASE_INPUT,
      mcp_token: "garbage",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid MCP token format/);
    expect(vi.mocked(getUserByMcpToken)).not.toHaveBeenCalled();
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();
  });

  it("fails when getUserByMcpToken returns null", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue(null);

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid or expired MCP token/);
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("registerSubmitConsentDecisionTool — happy path", () => {
  it("records an approve decision and returns CONSENT RECORDED", async () => {
    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/^CONSENT RECORDED/);
    expect(text).toMatch(/Decision: auto_create_dedicated_email/);
    expect(text).toMatch(/Status: approved/);
    expect(text).toMatch(/You may now proceed/);

    expect(vi.mocked(recordConsentDecision)).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CONSENT_ID,
        userId: MOCK_USER.id,
        status: "approved",
        decision: "auto_create_dedicated_email",
      })
    );
  });

  it("routes 'decline' to status=declined", async () => {
    vi.mocked(recordConsentDecision).mockResolvedValue(
      pendingRow({
        status: "declined",
        decision: "decline",
        decision_made_at: new Date().toISOString(),
      })
    );

    const result = await handler!({ ...BASE_INPUT, decision: "decline" });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(/Status: declined/);
    expect(text).toMatch(/Do NOT proceed/);

    expect(vi.mocked(recordConsentDecision)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "declined", decision: "decline" })
    );
  });
});

// ---------------------------------------------------------------------------
// Rejection paths
// ---------------------------------------------------------------------------

describe("registerSubmitConsentDecisionTool — rejections", () => {
  it("rejects when the consent_id is unknown", async () => {
    vi.mocked(getConsentRequest).mockResolvedValue(null);

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Consent request not found/);
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();
  });

  it("rejects a decision that is not in the row's options", async () => {
    vi.mocked(getConsentRequest).mockResolvedValue(
      pendingRow({ options: ["approve", "decline"] })
    );

    const result = await handler!({ ...BASE_INPUT, decision: "approve_extra" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid decision "approve_extra"/);
    expect(result.content[0]!.text).toMatch(/"approve", "decline"/);
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();
  });

  it("rejects when the row has already been decided", async () => {
    vi.mocked(getConsentRequest).mockResolvedValue(
      pendingRow({
        status: "approved",
        decision: "auto_create_dedicated_email",
        decision_made_at: new Date().toISOString(),
      })
    );

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/already approved/);
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();
  });

  it("rejects when the row has expired", async () => {
    vi.mocked(getConsentRequest).mockResolvedValue(
      pendingRow({
        // expires_at in the past — still status='pending' (the row hasn't
        // been swept yet) but we must refuse to record a decision.
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      })
    );

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Consent request expired/);
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();
  });

  it("surfaces a CAS-loss when recordConsentDecision returns null", async () => {
    // Concurrent caller flipped the row to approved between our read and
    // our write. The re-read must surface the final state to the agent.
    vi.mocked(recordConsentDecision).mockResolvedValue(null);
    vi.mocked(getConsentRequest)
      .mockResolvedValueOnce(pendingRow())
      .mockResolvedValueOnce(
        pendingRow({
          status: "approved",
          decision: "auto_create_dedicated_email",
          decision_made_at: new Date().toISOString(),
        })
      );

    const result = await handler!(BASE_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/already approved/);
  });
});
