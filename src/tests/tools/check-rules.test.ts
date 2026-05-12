/**
 * Tests for src/tools/check-rules.ts — registerCheckRulesTool
 *
 * Both modes are exercised:
 *   - "list" mode (no service/amount) → returns active rules.
 *   - "simulate" mode (service + amount) → returns APPROVED / DECLINED.
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
import { registerCheckRulesTool } from "../../tools/check-rules.js";

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

const VALID_TOKEN = "spx_" + "b".repeat(32);

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
  registerCheckRulesTool(mockServer as any);
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

describe("registerCheckRulesTool — list mode", () => {
  it("lists active rules when no service/amount is supplied", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r1",
        user_id: "user_123",
        service_filter: null,
        max_per_transaction_usd: 100,
        monthly_budget_usd: 500,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
      {
        id: "r2",
        user_id: "user_123",
        service_filter: "modal",
        max_per_transaction_usd: 25,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);

    const result = await handler!({ mcp_token: VALID_TOKEN });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toMatch(/Auto-approve cap/);
    expect(text).toMatch(/Active rules \(2\)/);
    expect(text).toContain("all services");
    expect(text).toContain("modal");
  });

  it("reports 'no additional rules' when only the user-level cap exists", async () => {
    const result = await handler!({ mcp_token: VALID_TOKEN });
    expect(result.content[0].text).toMatch(/No additional spending rules/);
  });
});

describe("registerCheckRulesTool — simulate mode", () => {
  it("APPROVES a charge within all limits", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r1",
        user_id: "user_123",
        service_filter: null,
        max_per_transaction_usd: 100,
        monthly_budget_usd: 500,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(50);

    const result = await handler!({
      mcp_token: VALID_TOKEN,
      service: "vercel",
      amount_usd: 10,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/APPROVED/);
  });

  it("DECLINES a charge over the per-transaction cap", async () => {
    vi.mocked(getRulesForUser).mockResolvedValue([
      {
        id: "r1",
        user_id: "user_123",
        service_filter: null,
        max_per_transaction_usd: 5,
        monthly_budget_usd: null,
        allowed_services: null,
        blocked_services: null,
        active: true,
      },
    ]);

    const result = await handler!({
      mcp_token: VALID_TOKEN,
      service: "modal",
      amount_usd: 20,
    });
    expect(result.content[0].text).toMatch(/DECLINED/);
    expect(result.content[0].text).toMatch(/per-transaction limit/);
  });

  it("DECLINES a charge that would push monthly spend over budget", async () => {
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
    vi.mocked(getMonthlySpendUsd).mockResolvedValue(95);

    const result = await handler!({
      mcp_token: VALID_TOKEN,
      service: "vercel",
      amount_usd: 10,
    });
    expect(result.content[0].text).toMatch(/DECLINED/);
    expect(result.content[0].text).toMatch(/over the \$100/);
  });

  it("DECLINES a charge above the user-level auto-approve cap", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      max_auto_charge_usd: 10,
    } as any);

    const result = await handler!({
      mcp_token: VALID_TOKEN,
      service: "vercel",
      amount_usd: 25,
    });
    expect(result.content[0].text).toMatch(/DECLINED/);
    expect(result.content[0].text).toMatch(/auto-approve limit/);
  });
});
