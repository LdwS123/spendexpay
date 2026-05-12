/**
 * Tests for src/tools/check-balance.ts — registerCheckBalanceTool
 *
 * Mocks all DB / rate-limit / config so no network is touched. The handler is
 * captured via a fake McpServer then invoked directly.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  getRulesForUser: vi.fn(),
  getMonthlySpendUsd: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("../../config.js", () => {
  const cfg = { emergencyStop: false };
  return { config: cfg, DEV_MODE: false };
});

import {
  getUserByMcpToken,
  getRulesForUser,
  getMonthlySpendUsd,
} from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import { registerCheckBalanceTool } from "../../tools/check-balance.js";

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
  registerCheckBalanceTool(mockServer as any);
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(getRulesForUser).mockReset();
  vi.mocked(getMonthlySpendUsd).mockReset();

  (config as any).emergencyStop = false;

  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(getRulesForUser).mockResolvedValue([]);
  vi.mocked(getMonthlySpendUsd).mockResolvedValue(0);
});

describe("registerCheckBalanceTool — rate limit", () => {
  it("returns isError when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfterMs: 3000,
    });
    const result = await handler!({ mcp_token: VALID_TOKEN });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many requests/);
  });
});

describe("registerCheckBalanceTool — emergency stop", () => {
  it("returns isError when emergencyStop is set", async () => {
    (config as any).emergencyStop = true;
    const result = await handler!({ mcp_token: VALID_TOKEN });
    (config as any).emergencyStop = false;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/maintenance/i);
  });
});

describe("registerCheckBalanceTool — invalid token format", () => {
  it("rejects malformed tokens before hitting the DB", async () => {
    const result = await handler!({ mcp_token: "not-a-spendex-token" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid MCP token format/);
    expect(vi.mocked(getUserByMcpToken)).not.toHaveBeenCalled();
  });
});

describe("registerCheckBalanceTool — invalid token", () => {
  it("returns isError when user lookup fails", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue(null as any);
    const result = await handler!({ mcp_token: VALID_TOKEN });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid or expired/);
  });
});

describe("registerCheckBalanceTool — no rules", () => {
  it("reports spend with no monthly budget and uses max_auto_charge_usd as per-tx", async () => {
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(12.5);

    const result = await handler!({ mcp_token: VALID_TOKEN });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("$12.50");
    expect(text).toMatch(/No monthly budget configured/);
    expect(text).toContain("$50.00");
  });
});

describe("registerCheckBalanceTool — with monthly budget rule", () => {
  it("reports percent used when a global monthly budget exists", async () => {
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(25);
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r1",
        user_id: "user_123",
        service_filter: null,
        max_per_transaction_usd: null,
        monthly_budget_usd: 100,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);

    const result = await handler!({ mcp_token: VALID_TOKEN });
    const text = result.content[0].text;
    expect(text).toContain("$25.00");
    expect(text).toContain("$100.00");
    expect(text).toMatch(/25% used/);
  });
});

describe("registerCheckBalanceTool — rule per-tx cap overrides user cap when lower", () => {
  it("picks the smaller of (rule per-tx, user max_auto_charge_usd)", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r1",
        user_id: "user_123",
        service_filter: null,
        max_per_transaction_usd: 10,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);

    const result = await handler!({ mcp_token: VALID_TOKEN });
    expect(result.content[0].text).toContain("$10.00");
  });
});

describe("registerCheckBalanceTool — service-scoped rules ignored", () => {
  it("does not surface per-service rules in the global introspection view", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r1",
        user_id: "user_123",
        service_filter: "modal",
        max_per_transaction_usd: 5,
        monthly_budget_usd: 20,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);

    const result = await handler!({ mcp_token: VALID_TOKEN });
    const text = result.content[0].text;
    // Falls back to user.max_auto_charge_usd, no monthly budget set globally.
    expect(text).toContain("$50.00");
    expect(text).toMatch(/No monthly budget configured/);
  });
});
