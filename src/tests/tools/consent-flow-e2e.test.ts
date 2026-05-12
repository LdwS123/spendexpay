/**
 * End-to-end test for the inline consent flow.
 *
 * Exercises the three consent tools together against a shared, in-memory
 * mock of the consent_requests table:
 *
 *   request_user_consent  -> insert pending row, return consent_id
 *   check_consent_status  -> read row by id+user_id
 *   submit_consent_decision -> CAS transition pending -> approved/declined
 *
 * Unlike the per-tool unit tests, this suite drives all three handlers in
 * sequence over a single fake row to make sure they agree on the contract:
 *
 *   1. After request → row exists, status='pending', check returns PENDING
 *   2. After submit('approve') → row mutated, check returns APPROVED
 *   3. Error: submit with a decision not in row.options → rejected
 *   4. Error: submit on an expired row → rejected, row not mutated
 *   5. Error: submit from a different user_id → ownership-scoped fetch
 *      returns null, so submit sees "not found"
 *
 * Mocks follow the same pattern as request-consent.test.ts and
 * submit-consent.test.ts: Supabase, rate-limit, and config are all faked,
 * and the MCP server is a { tool } stub that captures each handler.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must precede any import of the modules under test.
// ---------------------------------------------------------------------------

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  getOrCreateConsentPreferences: vi.fn(),
  createConsentRequest: vi.fn(),
  getConsentRequest: vi.fn(),
  recordConsentDecision: vi.fn(),
  // The widget-payload path reads these to populate the consent dialog's
  // "Within your rules" section. They are best-effort and do not affect
  // the e2e contract being asserted here.
  getMonthlySpendUsd: vi.fn().mockResolvedValue(0),
  getRulesForUser: vi.fn().mockResolvedValue([]),
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
  getConsentRequest,
  recordConsentDecision,
  type ConsentPreferences,
  type ConsentRequestRecord,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import { registerRequestConsentTool } from "../../tools/request-consent.js";
import { registerSubmitConsentDecisionTool } from "../../tools/submit-consent.js";
import { registerCheckConsentStatusTool } from "../../tools/check-consent-status.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "e".repeat(32);
const OTHER_TOKEN = "spx_" + "f".repeat(32);
const CONSENT_ID = "33333333-3333-3333-3333-333333333333";

const MOCK_USER = {
  id: "user_e2e",
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
  max_auto_charge_usd: 100,
};

const OTHER_USER = {
  ...MOCK_USER,
  id: "user_intruder",
  email: "mallory@example.com",
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

const BASE_REQUEST_INPUT = {
  action: "pay_for_service" as const,
  service: "vercel",
  context: "Deploy 'my-app' to production",
  amount_usd: 25,
  mcp_token: VALID_TOKEN,
};

// ---------------------------------------------------------------------------
// Handler capture — register all three tools against a single fake server.
// ---------------------------------------------------------------------------

type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type Handler = (input: Record<string, unknown>) => Promise<HandlerResult>;

const handlers: Record<string, Handler> = {};

// request-consent uses `registerAppTool` (from @modelcontextprotocol/ext-apps),
// which calls `server.registerTool(name, config, handler)`. The other two
// tools still use the older `server.tool(name, desc, schema, handler)` shape.
// The fake server supports both so we can drive them all from one suite.
const mockServer = {
  tool: vi.fn(),
  registerTool: vi.fn(),
};

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (
      name: string,
      _desc: string,
      _schema: unknown,
      h: Handler
    ) => {
      handlers[name] = h;
    }
  );
  mockServer.registerTool.mockImplementation(
    (name: string, _config: Record<string, unknown>, h: Handler) => {
      handlers[name] = h;
      return { enable: () => {}, disable: () => {}, update: () => {}, remove: () => {} };
    }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerRequestConsentTool(mockServer as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSubmitConsentDecisionTool(mockServer as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerCheckConsentStatusTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// In-memory consent_requests "table" — gives the mocks a coherent state
// model so request/check/submit can interact like they would against
// Supabase.
// ---------------------------------------------------------------------------

interface FakeStore {
  rows: Map<string, ConsentRequestRecord>;
}

let store: FakeStore;

function freshRow(overrides: Partial<ConsentRequestRecord> = {}): ConsentRequestRecord {
  return {
    id: CONSENT_ID,
    user_id: MOCK_USER.id,
    action: "pay_for_service",
    service: "vercel",
    amount_usd: 25,
    context: { description: BASE_REQUEST_INPUT.context, reason: null },
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

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(getOrCreateConsentPreferences).mockReset();
  vi.mocked(createConsentRequest).mockReset();
  vi.mocked(getConsentRequest).mockReset();
  vi.mocked(recordConsentDecision).mockReset();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config as any).emergencyStop = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config as any).dashboardUrl = null;

  store = { rows: new Map() };

  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });

  // Token routing: valid token => MOCK_USER, "other" token => OTHER_USER.
  vi.mocked(getUserByMcpToken).mockImplementation(async (token: string) => {
    if (token === VALID_TOKEN) return MOCK_USER as never;
    if (token === OTHER_TOKEN) return OTHER_USER as never;
    return null;
  });

  vi.mocked(getOrCreateConsentPreferences).mockResolvedValue(ALWAYS_ASK);

  // createConsentRequest writes into the shared store.
  vi.mocked(createConsentRequest).mockImplementation(async (params) => {
    const row = freshRow({
      id: CONSENT_ID,
      user_id: params.userId,
      action: params.action,
      service: params.service,
      amount_usd: params.amountUsd ?? null,
      context: params.context ?? null,
      options: params.options,
      expires_at: params.expiresAt.toISOString(),
    });
    store.rows.set(CONSENT_ID, row);
    return row;
  });

  // getConsentRequest enforces ownership: a different user_id returns null.
  vi.mocked(getConsentRequest).mockImplementation(async (id, userId) => {
    const row = store.rows.get(id);
    if (!row) return null;
    if (row.user_id !== userId) return null;
    return row;
  });

  // recordConsentDecision is a CAS update: only flips a row when it's
  // still pending AND not expired AND owned by the caller. Mirrors the
  // production filter on supabase (eq id, eq user_id, eq status='pending').
  vi.mocked(recordConsentDecision).mockImplementation(async (params) => {
    const row = store.rows.get(params.id);
    if (!row) return null;
    if (row.user_id !== params.userId) return null;
    if (row.status !== "pending") return null;

    const updated: ConsentRequestRecord = {
      ...row,
      status: params.status,
      decision: params.decision,
      decision_metadata: params.decisionMetadata ?? null,
      decision_made_at: new Date().toISOString(),
    };
    store.rows.set(params.id, updated);
    return updated;
  });
});

// ---------------------------------------------------------------------------
// Happy path: request → pending → submit(approve) → approved
// ---------------------------------------------------------------------------

describe("consent flow e2e — happy path", () => {
  it("walks request → pending → submit(approve) → approved end to end", async () => {
    // Step 1: agent calls request_user_consent.
    const requestResult = await handlers["request_user_consent"]!(BASE_REQUEST_INPUT);

    expect(requestResult.isError).toBeUndefined();
    const requestText = requestResult.content[0]!.text;
    expect(requestText).toMatch(/^CONSENT NEEDED/);
    expect(requestText).toContain(`Consent ID: ${CONSENT_ID}`);
    expect(requestText).toMatch(/submit_consent_decision/);
    expect(vi.mocked(createConsentRequest)).toHaveBeenCalledTimes(1);

    // Step 2: row should exist in our fake table with status='pending'.
    const stored = store.rows.get(CONSENT_ID);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("pending");
    expect(stored!.user_id).toBe(MOCK_USER.id);

    // Step 3: agent polls check_consent_status — should still be pending.
    const firstCheck = await handlers["check_consent_status"]!({
      consent_id: CONSENT_ID,
      mcp_token: VALID_TOKEN,
    });
    expect(firstCheck.isError).toBeUndefined();
    expect(firstCheck.content[0]!.text).toMatch(/^CONSENT PENDING/);
    expect(firstCheck.content[0]!.text).toContain(`Consent ID: ${CONSENT_ID}`);

    // Step 4: agent submits the user's "approve" decision.
    const submitResult = await handlers["submit_consent_decision"]!({
      consent_id: CONSENT_ID,
      decision: "approve",
      mcp_token: VALID_TOKEN,
    });
    expect(submitResult.isError).toBeUndefined();
    const submitText = submitResult.content[0]!.text;
    expect(submitText).toMatch(/^CONSENT RECORDED/);
    expect(submitText).toMatch(/Decision: approve/);
    expect(submitText).toMatch(/Status: approved/);
    expect(submitText).toMatch(/You may now proceed/);

    // Store should now reflect the new state.
    const afterSubmit = store.rows.get(CONSENT_ID)!;
    expect(afterSubmit.status).toBe("approved");
    expect(afterSubmit.decision).toBe("approve");
    expect(afterSubmit.decision_made_at).not.toBeNull();

    // Step 5: a second check_consent_status sees the same final state.
    const secondCheck = await handlers["check_consent_status"]!({
      consent_id: CONSENT_ID,
      mcp_token: VALID_TOKEN,
    });
    expect(secondCheck.isError).toBeUndefined();
    const secondCheckText = secondCheck.content[0]!.text;
    expect(secondCheckText).toMatch(/^CONSENT APPROVED/);
    expect(secondCheckText).toMatch(/Decision: approve/);
    expect(secondCheckText).toMatch(/You may now proceed/);
  });
});

// ---------------------------------------------------------------------------
// Error: decision not in the row's options
// ---------------------------------------------------------------------------

describe("consent flow e2e — invalid decision option", () => {
  it("rejects submit_consent_decision when the decision is not in options", async () => {
    // Seed a real pending row via request_user_consent so submit sees it.
    const requestResult = await handlers["request_user_consent"]!(BASE_REQUEST_INPUT);
    expect(requestResult.isError).toBeUndefined();
    expect(store.rows.get(CONSENT_ID)!.options).toEqual(["approve", "decline"]);

    // Submit with a slug that's NOT in options.
    const submitResult = await handlers["submit_consent_decision"]!({
      consent_id: CONSENT_ID,
      decision: "approve_with_extras",
      mcp_token: VALID_TOKEN,
    });

    expect(submitResult.isError).toBe(true);
    const text = submitResult.content[0]!.text;
    expect(text).toMatch(/Invalid decision "approve_with_extras"/);
    expect(text).toMatch(/"approve", "decline"/);

    // recordConsentDecision must NOT have been called — the option check
    // runs before any DB write.
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();

    // The row stays pending.
    expect(store.rows.get(CONSENT_ID)!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Error: submit on an expired row
// ---------------------------------------------------------------------------

describe("consent flow e2e — expired row", () => {
  it("rejects submit_consent_decision after the row's expires_at has passed", async () => {
    // Pre-seed the store with a pending row that's already past its
    // expires_at. We skip request_user_consent here because we need control
    // over expires_at directly.
    store.rows.set(
      CONSENT_ID,
      freshRow({
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      })
    );

    const submitResult = await handlers["submit_consent_decision"]!({
      consent_id: CONSENT_ID,
      decision: "approve",
      mcp_token: VALID_TOKEN,
    });

    expect(submitResult.isError).toBe(true);
    expect(submitResult.content[0]!.text).toMatch(/Consent request expired/);
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();

    // Row state unchanged — still pending in the store.
    expect(store.rows.get(CONSENT_ID)!.status).toBe("pending");
    expect(store.rows.get(CONSENT_ID)!.decision).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error: ownership — a different user's token cannot decide our row
// ---------------------------------------------------------------------------

describe("consent flow e2e — ownership enforcement", () => {
  it("rejects submit_consent_decision when called with a different user's token", async () => {
    // User A creates the row.
    const requestResult = await handlers["request_user_consent"]!(BASE_REQUEST_INPUT);
    expect(requestResult.isError).toBeUndefined();
    expect(store.rows.get(CONSENT_ID)!.user_id).toBe(MOCK_USER.id);

    // User B (intruder) tries to submit a decision for it. Our
    // getConsentRequest mock enforces user_id matching — so the tool sees
    // "not found" and refuses, exactly like the production filter.
    const intruderSubmit = await handlers["submit_consent_decision"]!({
      consent_id: CONSENT_ID,
      decision: "approve",
      mcp_token: OTHER_TOKEN,
    });

    expect(intruderSubmit.isError).toBe(true);
    expect(intruderSubmit.content[0]!.text).toMatch(
      /Consent request not found for this token/
    );

    // CAS update must never have been invoked.
    expect(vi.mocked(recordConsentDecision)).not.toHaveBeenCalled();

    // Row remains pending and still belongs to the original user.
    const stored = store.rows.get(CONSENT_ID)!;
    expect(stored.status).toBe("pending");
    expect(stored.decision).toBeNull();
    expect(stored.user_id).toBe(MOCK_USER.id);

    // For completeness: check_consent_status from the intruder also
    // returns "not found" rather than leaking the row's existence.
    const intruderCheck = await handlers["check_consent_status"]!({
      consent_id: CONSENT_ID,
      mcp_token: OTHER_TOKEN,
    });
    expect(intruderCheck.isError).toBe(true);
    expect(intruderCheck.content[0]!.text).toMatch(
      /Consent request not found for this token/
    );

    // And the owner CAN still submit, proving the row wasn't poisoned.
    const ownerSubmit = await handlers["submit_consent_decision"]!({
      consent_id: CONSENT_ID,
      decision: "approve",
      mcp_token: VALID_TOKEN,
    });
    expect(ownerSubmit.isError).toBeUndefined();
    expect(ownerSubmit.content[0]!.text).toMatch(/Status: approved/);
    expect(store.rows.get(CONSENT_ID)!.status).toBe("approved");
  });
});
