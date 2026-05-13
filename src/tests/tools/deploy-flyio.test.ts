/**
 * Tests for src/tools/deploy-flyio.ts — registerDeployFlyioTool
 *
 * We mock all I/O (DB, rate-limit, payment router, Fly.io API) so no
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

const { mockPollFlyDeployment } = vi.hoisted(() => ({
  mockPollFlyDeployment: vi.fn(),
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

vi.mock("../../lib/flyio.js", () => ({
  triggerFlyDeploy: vi.fn(),
  pollFlyDeployment: mockPollFlyDeployment,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { routePayment } from "../../lib/payments/router.js";
import { triggerFlyDeploy } from "../../lib/flyio.js";
import { registerDeployFlyioTool } from "../../tools/deploy-flyio.js";
import {
  createHandlerCapture,
  makeDeployUser,
  makeMockCharge,
} from "../fixtures.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = makeDeployUser();

const MOCK_CHARGE = makeMockCharge();

const MOCK_DEPLOY_RESULT = {
  releaseId: "rel_123",
  url: "https://my-fly-app.fly.dev",
};

const INPUT = { app_name: "my-fly-app", mcp_token: "spx_tok" };

// ---------------------------------------------------------------------------
// Handler capture — registered once for all tests
// ---------------------------------------------------------------------------

const { mockServer, getHandler } = createHandlerCapture();

beforeAll(() => {
  registerDeployFlyioTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mock state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(triggerFlyDeploy).mockReset();
  mockPollFlyDeployment.mockReset();
  vi.mocked(logTransaction).mockReset();

  // Happy-path defaults — individual tests override what they need
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(triggerFlyDeploy).mockResolvedValue(MOCK_DEPLOY_RESULT);
  mockPollFlyDeployment.mockResolvedValue({ url: MOCK_DEPLOY_RESULT.url, state: "READY" });
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerDeployFlyioTool — rate limit denied", () => {
  it("returns isError:true with 'Too many requests' when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfterMs: 10000,
    });

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many requests/);
    // The retryAfterMs value must be surfaced to the caller
    expect(result.content[0].text).toMatch(/10 second/);
  });
});

describe("registerDeployFlyioTool — emergency stop", () => {
  it("returns isError:true with 'paused' when emergencyStop is true", async () => {
    const configMod = await import("../../config.js");
    (configMod.config as any).emergencyStop = true;

    const result = await getHandler()!(INPUT);

    (configMod.config as any).emergencyStop = false;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/paused/);
  });
});

describe("registerDeployFlyioTool — invalid MCP token", () => {
  it("returns isError:true with 'Invalid or expired' when getUserByMcpToken returns null", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue(null as any);

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid or expired/);
  });
});

describe("registerDeployFlyioTool — missing Fly.io token", () => {
  it("returns isError:true with 'No Fly.io token' when user has no fly_token", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      fly_token: "",
    } as any);

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No Fly\.io token/);
  });
});

describe("registerDeployFlyioTool — payment failure", () => {
  it("returns isError:true with 'Payment failed' and logs payment_failed when routePayment throws", async () => {
    vi.mocked(routePayment).mockRejectedValue(new Error("Card requires authentication"));

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Payment failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "payment_failed" })
    );
  });
});

describe("registerDeployFlyioTool — deploy failure after payment", () => {
  it("returns isError:true referencing Fly.io and logs deploy_failed_after_payment when triggerFlyDeploy throws", async () => {
    vi.mocked(triggerFlyDeploy).mockRejectedValue(
      new Error("Fly.io API error 422: app not found")
    );

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text.toLowerCase()).toMatch(/fly\.io|deploy failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});

describe("registerDeployFlyioTool — success", () => {
  it("returns the app URL and logs success on a fully successful deploy", async () => {
    const result = await getHandler()!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("my-fly-app.fly.dev");

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("passes app_name through to triggerFlyDeploy", async () => {
    await getHandler()!(INPUT);

    expect(vi.mocked(triggerFlyDeploy)).toHaveBeenCalledWith(
      expect.objectContaining({ appName: "my-fly-app" })
    );
  });
});
