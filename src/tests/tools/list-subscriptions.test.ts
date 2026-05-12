/**
 * Tests for src/tools/list-subscriptions.ts — registerListSubscriptionsTool
 *
 * All I/O is mocked (DB, tool-auth). The handler is captured via a fake
 * McpServer so it can be invoked directly.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../../lib/db.js", () => ({
  listSubscriptionsForUser: vi.fn(),
}));

vi.mock("../../lib/tool-auth.js", () => ({
  authenticateToolCall: vi.fn(),
}));

vi.mock("../../config.js", () => {
  const cfg = { emergencyStop: false };
  return { config: cfg, DEV_MODE: false };
});

import { listSubscriptionsForUser } from "../../lib/db.js";
import { authenticateToolCall } from "../../lib/tool-auth.js";
import { registerListSubscriptionsTool } from "../../tools/list-subscriptions.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "spx_" + "a".repeat(32);

const MOCK_USER = {
  id: "user_list_1",
  email: "t@t.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as any,
  max_auto_charge_usd: 50,
};

const SUB_ACTIVE_MONTHLY = {
  id: "11111111-1111-1111-1111-111111111111",
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

const SUB_ACTIVE_YEARLY = {
  ...SUB_ACTIVE_MONTHLY,
  id: "22222222-2222-2222-2222-222222222222",
  service: "jetbrains",
  amount_usd: 120,
  interval: "yearly" as const,
  description: "JetBrains All Products Pack",
};

const SUB_CANCELLED = {
  ...SUB_ACTIVE_MONTHLY,
  id: "33333333-3333-3333-3333-333333333333",
  service: "old-service",
  amount_usd: 5,
  status: "cancelled" as const,
  cancelled_at: "2026-04-01T00:00:00.000Z",
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
  registerListSubscriptionsTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(authenticateToolCall).mockReset();
  vi.mocked(listSubscriptionsForUser).mockReset();

  vi.mocked(authenticateToolCall).mockResolvedValue({
    ok: true,
    user: MOCK_USER as any,
  } as any);
  vi.mocked(listSubscriptionsForUser).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerListSubscriptionsTool — auth failure", () => {
  it("propagates the auth failure response", async () => {
    vi.mocked(authenticateToolCall).mockResolvedValue({
      ok: false,
      response: {
        content: [{ type: "text", text: "Invalid or expired MCP token." }],
        isError: true,
      },
    } as any);

    const result = await handler!({ mcp_token: VALID_TOKEN });

    expect(result.isError).toBe(true);
    expect(vi.mocked(listSubscriptionsForUser)).not.toHaveBeenCalled();
  });
});

describe("registerListSubscriptionsTool — empty list", () => {
  it("returns a friendly 'No subscriptions yet' message", async () => {
    const result = await handler!({ mcp_token: VALID_TOKEN });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/No subscriptions yet/);
  });
});

describe("registerListSubscriptionsTool — happy path", () => {
  it("renders each subscription with ID, amount, interval, and status", async () => {
    vi.mocked(listSubscriptionsForUser).mockResolvedValue([
      SUB_ACTIVE_MONTHLY,
      SUB_ACTIVE_YEARLY,
      SUB_CANCELLED,
    ] as any);

    const result = await handler!({ mcp_token: VALID_TOKEN });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Each subscription's ID appears
    expect(text).toContain(SUB_ACTIVE_MONTHLY.id);
    expect(text).toContain(SUB_ACTIVE_YEARLY.id);
    expect(text).toContain(SUB_CANCELLED.id);
    // Statuses surfaced in uppercase
    expect(text).toMatch(/ACTIVE/);
    expect(text).toMatch(/CANCELLED/);
    // Summary line includes the monthly-normalised total. Monthly $20 +
    // yearly $120 / 12 ($10) = $30; cancelled rows excluded.
    expect(text).toMatch(/3 subscriptions/);
    expect(text).toMatch(/2 active/);
    expect(text).toMatch(/\$30\.00/);
  });
});

describe("registerListSubscriptionsTool — DB error", () => {
  it("returns isError:true when listSubscriptionsForUser throws", async () => {
    vi.mocked(listSubscriptionsForUser).mockRejectedValue(new Error("PG down"));

    const result = await handler!({ mcp_token: VALID_TOKEN });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Could not load subscriptions/);
  });
});
