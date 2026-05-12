/**
 * Tests for src/tools/cancel-subscription.ts — registerCancelSubscriptionTool
 *
 * All I/O is mocked (DB, tool-auth) so no network calls are made. The handler
 * is captured via a fake McpServer so it can be invoked directly.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../../lib/db.js", () => ({
  cancelSubscription: vi.fn(),
  getSubscription: vi.fn(),
  logTransaction: vi.fn(),
}));

vi.mock("../../lib/tool-auth.js", () => ({
  authenticateToolCall: vi.fn(),
}));

vi.mock("../../config.js", () => {
  const cfg = { emergencyStop: false };
  return { config: cfg, DEV_MODE: false };
});

import {
  cancelSubscription,
  getSubscription,
  logTransaction,
} from "../../lib/db.js";
import { authenticateToolCall } from "../../lib/tool-auth.js";
import { registerCancelSubscriptionTool } from "../../tools/cancel-subscription.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUB_ID = "11111111-1111-1111-1111-111111111111";
const VALID_TOKEN = "spx_" + "a".repeat(32);

const MOCK_USER = {
  id: "user_cancel_1",
  email: "t@t.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as any,
  max_auto_charge_usd: 50,
};

const ACTIVE_SUB = {
  id: SUB_ID,
  user_id: MOCK_USER.id,
  service: "vercel",
  amount_usd: 20,
  currency: "USD",
  interval: "monthly" as const,
  status: "active" as const,
  description: "Vercel Pro plan",
  started_at: "2026-05-13T00:00:00.000Z",
  next_charge_at: "2026-06-13T00:00:00.000Z",
  last_charged_at: null,
  cancelled_at: null,
  metadata: null,
  created_at: "2026-05-13T00:00:00.000Z",
  updated_at: "2026-05-13T00:00:00.000Z",
};

const CANCELLED_SUB = {
  ...ACTIVE_SUB,
  status: "cancelled" as const,
  cancelled_at: "2026-05-13T01:00:00.000Z",
  updated_at: "2026-05-13T01:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Handler capture
// ---------------------------------------------------------------------------

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
  registerCancelSubscriptionTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(authenticateToolCall).mockReset();
  vi.mocked(getSubscription).mockReset();
  vi.mocked(cancelSubscription).mockReset();
  vi.mocked(logTransaction).mockReset();

  // Happy-path defaults
  vi.mocked(authenticateToolCall).mockResolvedValue({
    ok: true,
    user: MOCK_USER as any,
  } as any);
  vi.mocked(getSubscription).mockResolvedValue(ACTIVE_SUB as any);
  vi.mocked(cancelSubscription).mockResolvedValue(CANCELLED_SUB as any);
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerCancelSubscriptionTool — auth failure", () => {
  it("propagates the auth failure response", async () => {
    vi.mocked(authenticateToolCall).mockResolvedValue({
      ok: false,
      response: {
        content: [{ type: "text", text: "Invalid or expired MCP token." }],
        isError: true,
      },
    } as any);

    const result = await handler!({ subscription_id: SUB_ID, mcp_token: VALID_TOKEN });

    expect(result.isError).toBe(true);
    expect(vi.mocked(cancelSubscription)).not.toHaveBeenCalled();
  });
});

describe("registerCancelSubscriptionTool — not found / not owned", () => {
  it("returns isError:true when getSubscription returns null", async () => {
    vi.mocked(getSubscription).mockResolvedValue(null);

    const result = await handler!({ subscription_id: SUB_ID, mcp_token: VALID_TOKEN });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No subscription found/);
    expect(vi.mocked(cancelSubscription)).not.toHaveBeenCalled();
  });
});

describe("registerCancelSubscriptionTool — already cancelled", () => {
  it("returns success without mutating when row is already cancelled", async () => {
    vi.mocked(getSubscription).mockResolvedValue(CANCELLED_SUB as any);

    const result = await handler!({ subscription_id: SUB_ID, mcp_token: VALID_TOKEN });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/already cancelled/i);
    expect(vi.mocked(cancelSubscription)).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).not.toHaveBeenCalled();
  });
});

describe("registerCancelSubscriptionTool — happy path", () => {
  it("cancels the subscription and audit-logs subscription_cancel with amountUsd=0", async () => {
    const result = await handler!({ subscription_id: SUB_ID, mcp_token: VALID_TOKEN });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/SUBSCRIPTION CANCELLED/);

    expect(vi.mocked(cancelSubscription)).toHaveBeenCalledWith(SUB_ID, MOCK_USER.id);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER.id,
        service: "vercel",
        status: "success",
        amountUsd: 0,
        transactionType: "subscription_cancel",
        agentId: SUB_ID,
      })
    );
  });
});

describe("registerCancelSubscriptionTool — DB error during update", () => {
  it("returns isError:true when cancelSubscription throws", async () => {
    vi.mocked(cancelSubscription).mockRejectedValue(new Error("PG timeout"));

    const result = await handler!({ subscription_id: SUB_ID, mcp_token: VALID_TOKEN });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Could not cancel/);
  });
});
