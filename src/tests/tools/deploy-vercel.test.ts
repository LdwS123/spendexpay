/**
 * Tests for src/tools/deploy-vercel.ts — registerDeployVercelTool
 *
 * We mock all I/O (DB, rate-limit, payment router, Vercel API) so no
 * network calls or real Stripe/Supabase connections are made.
 *
 * The handler is captured via a mock McpServer so we can call it directly
 * and assert on the returned content array without spinning up a real server.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must appear before any imports that touch these modules.
// vi.mock is hoisted to the top of the file by Vitest.
// ---------------------------------------------------------------------------

const { mockPollVercelDeployment } = vi.hoisted(() => ({
  mockPollVercelDeployment: vi.fn(),
}));

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  logTransaction: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("../../config.js", () => {
  const cfg = { emergencyStop: false };
  return { config: cfg, DEV_MODE: false };
});

vi.mock("../../lib/payments/router.js", () => ({
  routePayment: vi.fn(),
}));

vi.mock("../../lib/vercel.js", () => ({
  triggerVercelDeploy: vi.fn(),
  pollVercelDeployment: mockPollVercelDeployment,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import { routePayment } from "../../lib/payments/router.js";
import { triggerVercelDeploy } from "../../lib/vercel.js";
import { registerDeployVercelTool } from "../../tools/deploy-vercel.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = {
  id: "user_123",
  email: "t@t.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as any,
  vercel_token: "vercel_tok_abc",
  netlify_token: "nlf",
  railway_token: "rly",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd",
  max_auto_charge_usd: 50,
};

const MOCK_CHARGE = {
  outcome: "charged" as const,
  transactionId: "pi_mock",
  paymentMethod: "stripe_card" as const,
};

const MOCK_DEPLOY_RESULT = {
  url: "https://my-app.vercel.app",
  deploymentId: "dpl_abc",
};

const INPUT = { project_name: "my-app", mcp_token: "spx_" + "a".repeat(32) };

// ---------------------------------------------------------------------------
// Handler capture — registered once for all tests
// ---------------------------------------------------------------------------

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
  registerDeployVercelTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mock state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(triggerVercelDeploy).mockReset();
  mockPollVercelDeployment.mockReset();
  vi.mocked(logTransaction).mockReset();

  // Ensure emergencyStop is false before every test
  (config as any).emergencyStop = false;

  // Happy-path defaults — individual tests override what they need
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(triggerVercelDeploy).mockResolvedValue(MOCK_DEPLOY_RESULT);
  mockPollVercelDeployment.mockResolvedValue({ url: MOCK_DEPLOY_RESULT.url, state: "READY" });
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerDeployVercelTool — rate limit denied", () => {
  it("returns isError:true with retryAfterMs in message when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfterMs: 8000,
    });

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many requests/);
    // retryAfterMs 8000 → 8 seconds — must be surfaced to the caller
    expect(result.content[0].text).toMatch(/8 second/);
  });
});

describe("registerDeployVercelTool — emergency stop", () => {
  it("returns isError:true with maintenance message when emergencyStop is true", async () => {
    (config as any).emergencyStop = true;

    const result = await handler!(INPUT);

    (config as any).emergencyStop = false;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/maintenance/i);
  });
});

describe("registerDeployVercelTool — invalid MCP token", () => {
  it("returns isError:true with 'Invalid or expired' when getUserByMcpToken returns null", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue(null as any);

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid or expired/);
  });
});

describe("registerDeployVercelTool — payment failure", () => {
  it("returns isError:true with 'Payment failed' and logs payment_failed when routePayment throws", async () => {
    vi.mocked(routePayment).mockRejectedValue(new Error("Card declined"));

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Payment failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "payment_failed" })
    );
  });
});

describe("registerDeployVercelTool — deploy failure after payment", () => {
  it("returns isError:true referencing project or failure context and logs deploy_failed_after_payment when triggerVercelDeploy throws", async () => {
    vi.mocked(triggerVercelDeploy).mockRejectedValue(
      new Error("Vercel API error 500: Internal Server Error")
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // The error message must reference the deploy failure or the project name
    expect(text.toLowerCase()).toMatch(/vercel deploy failed|my-app|failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});

describe("registerDeployVercelTool — success", () => {
  it("returns the deployment URL and logs success on a fully successful deploy", async () => {
    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("my-app.vercel.app");

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });
});

describe("registerDeployVercelTool — team_slug in description", () => {
  it("includes team_slug in the logTransaction description when team_slug is provided", async () => {
    const inputWithTeam = {
      project_name: "app",
      team_slug: "my-team",
      mcp_token: "spx_" + "b".repeat(32),
    };

    const result = await handler!(inputWithTeam);

    // Must succeed so logTransaction is called with the success payload
    expect(result.isError).toBeUndefined();

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        description: expect.stringContaining("my-team"),
      })
    );
  });
});
