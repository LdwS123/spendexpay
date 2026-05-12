/**
 * Tests for src/tools/deploy-railway.ts — registerDeployRailwayTool
 *
 * We mock all I/O (DB, rate-limit, payment router, Railway API) so no
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

const { mockPollRailwayDeployment } = vi.hoisted(() => ({
  mockPollRailwayDeployment: vi.fn(),
}));

vi.mock("../../lib/db.js", () => ({
  getUserByMcpToken: vi.fn(),
  logTransaction: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  config: { emergencyStop: false },
  DEV_MODE: false,
}));

vi.mock("../../lib/payments/router.js", () => ({
  routePayment: vi.fn(),
}));

vi.mock("../../lib/railway.js", () => ({
  triggerRailwayDeploy: vi.fn(),
  pollRailwayDeployment: mockPollRailwayDeployment,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { routePayment } from "../../lib/payments/router.js";
import { triggerRailwayDeploy } from "../../lib/railway.js";
import { registerDeployRailwayTool } from "../../tools/deploy-railway.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = {
  id: "user_123",
  email: "t@t.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as any,
  vercel_token: "v",
  netlify_token: "nlf_tok",
  railway_token: "rly_tok",
  fly_token: "fly_tok",
  replicate_token: "rep_tok",
  render_token: "rnd_tok",
  max_auto_charge_usd: 50,
};

const MOCK_CHARGE = {
  outcome: "charged" as const,
  transactionId: "pi_mock",
  paymentMethod: "stripe_card" as const,
};

const MOCK_DEPLOY_RESULT = {
  deploymentId: "dep_123",
  url: "https://railway.app/dashboard",
};

// Base input; tests may add environment_id to exercise the optional field
const INPUT = { service_id: "srv-abc123", mcp_token: "spx_tok" };

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
  registerDeployRailwayTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mock state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(triggerRailwayDeploy).mockReset();
  mockPollRailwayDeployment.mockReset();
  vi.mocked(logTransaction).mockReset();

  // Happy-path defaults — individual tests override what they need
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(triggerRailwayDeploy).mockResolvedValue(MOCK_DEPLOY_RESULT);
  mockPollRailwayDeployment.mockResolvedValue({ url: MOCK_DEPLOY_RESULT.url, state: "READY" });
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerDeployRailwayTool — rate limit denied", () => {
  it("returns isError:true with 'Too many requests' when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfterMs: 3000,
    });

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many requests/);
    // The retryAfterMs value must be surfaced to the caller
    expect(result.content[0].text).toMatch(/3 second/);
  });
});

describe("registerDeployRailwayTool — emergency stop", () => {
  it("returns isError:true with 'paused' when emergencyStop is true", async () => {
    const configMod = await import("../../config.js");
    (configMod.config as any).emergencyStop = true;

    const result = await handler!(INPUT);

    (configMod.config as any).emergencyStop = false;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/paused/);
  });
});

describe("registerDeployRailwayTool — invalid MCP token", () => {
  it("returns isError:true with 'Invalid or expired' when getUserByMcpToken returns null", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue(null as any);

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid or expired/);
  });
});

describe("registerDeployRailwayTool — missing Railway token", () => {
  it("returns isError:true with 'No Railway token' when user has no railway_token", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      railway_token: "",
    } as any);

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No Railway token/);
  });
});

describe("registerDeployRailwayTool — payment failure", () => {
  it("returns isError:true with 'Payment failed' and logs payment_failed when routePayment throws", async () => {
    vi.mocked(routePayment).mockRejectedValue(new Error("Insufficient funds"));

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Payment failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "payment_failed" })
    );
  });
});

describe("registerDeployRailwayTool — deploy failure after payment", () => {
  it("returns isError:true referencing Railway and logs deploy_failed_after_payment when triggerRailwayDeploy throws", async () => {
    vi.mocked(triggerRailwayDeploy).mockRejectedValue(
      new Error("Railway API error 503: Service Unavailable")
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text.toLowerCase()).toMatch(/railway|deploy failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("also works when environment_id is provided alongside service_id", async () => {
    vi.mocked(triggerRailwayDeploy).mockRejectedValue(
      new Error("Railway API error: environment not found")
    );

    const result = await handler!({ ...INPUT, environment_id: "env-xyz" });

    expect(result.isError).toBe(true);
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});

describe("registerDeployRailwayTool — success", () => {
  it("returns the dashboard URL and logs success on a fully successful deploy", async () => {
    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("railway.app/dashboard");

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("passes environment_id through to triggerRailwayDeploy when provided", async () => {
    await handler!({ ...INPUT, environment_id: "env-xyz" });

    expect(vi.mocked(triggerRailwayDeploy)).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "env-xyz" })
    );
  });
});
