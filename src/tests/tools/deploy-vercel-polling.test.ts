/**
 * Tests for polling behaviour wired into registerDeployVercelTool.
 *
 * We mock ../../lib/vercel.js with TWO independent functions so we can
 * control triggerVercelDeploy and pollVercelDeployment independently.
 *
 * All other I/O (DB, rate-limit, payment router) is mocked to the happy
 * path so each test focuses purely on the polling branch.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted before any imports that touch these modules.
// ---------------------------------------------------------------------------

const { mockTriggerVercelDeploy, mockPollVercelDeployment } = vi.hoisted(() => ({
  mockTriggerVercelDeploy: vi.fn(),
  mockPollVercelDeployment: vi.fn(),
}));

vi.mock("../../lib/vercel.js", () => ({
  triggerVercelDeploy: mockTriggerVercelDeploy,
  pollVercelDeployment: mockPollVercelDeployment,
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

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { routePayment } from "../../lib/payments/router.js";
import { registerDeployVercelTool } from "../../tools/deploy-vercel.js";
import { ProviderError } from "../../lib/provider-error.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = {
  id: "user_poll",
  email: "poll@test.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_poll" as any,
  vercel_token: "vercel_tok_poll",
  netlify_token: "nlf",
  railway_token: "rly",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd",
  max_auto_charge_usd: 50,
};

const MOCK_CHARGE = {
  outcome: "charged" as const,
  transactionId: "pi_poll_mock",
  paymentMethod: "stripe_card" as const,
};

// triggerVercelDeploy always resolves to this
const TRIGGER_RESULT = {
  deploymentId: "dpl_123",
  url: "https://original.vercel.app",
};

const INPUT = { project_name: "poll-app", mcp_token: "spx_" + "d".repeat(32) };

// ---------------------------------------------------------------------------
// Handler capture
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
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockTriggerVercelDeploy.mockReset();
  mockPollVercelDeployment.mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(checkRateLimit).mockReset();

  // Happy-path defaults
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);

  // triggerVercelDeploy always succeeds in these tests
  mockTriggerVercelDeploy.mockResolvedValue(TRIGGER_RESULT);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy_to_vercel — polling integration", () => {
  it("1. Poll returns READY → success response contains the polled URL", async () => {
    const polledUrl = "https://polled-ready.vercel.app";
    mockPollVercelDeployment.mockResolvedValue({ url: polledUrl, state: "READY" });

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(polledUrl);
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("2. Poll throws ProviderError code='unknown' (build failed) → tool returns deploy failure message and logs deploy_failed_after_payment", async () => {
    mockPollVercelDeployment.mockRejectedValue(
      new ProviderError(
        "unknown",
        "Vercel build failed (state: ERROR). Check the Vercel dashboard for build logs.",
        "vercel"
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Vercel deploy failed/i);
    expect(result.content[0].text).toContain(
      "Vercel build failed (state: ERROR). Check the Vercel dashboard for build logs."
    );
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("3. Poll throws ProviderError code='network' → tool returns deploy failure message", async () => {
    mockPollVercelDeployment.mockRejectedValue(
      new ProviderError(
        "network",
        "Could not reach vercel. Check your internet connection and try again.",
        "vercel"
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Vercel deploy failed/i);
    expect(result.content[0].text).toContain("Could not reach vercel");
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("4. Poll returns a different URL than triggerVercelDeploy → final URL comes from poll", async () => {
    const polledUrl = "https://final-from-poll.vercel.app";
    // triggerVercelDeploy returns "https://original.vercel.app"
    // poll returns a different URL — the tool must use the polled one
    mockPollVercelDeployment.mockResolvedValue({ url: polledUrl, state: "READY" });

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    // Final URL must be the polled URL, not the original trigger URL
    expect(result.content[0].text).toContain(polledUrl);
    expect(result.content[0].text).not.toContain("original.vercel.app");
  });

  it("5. trigger fails → poll is never called (trigger failure short-circuits before polling)", async () => {
    mockTriggerVercelDeploy.mockRejectedValue(
      new ProviderError("server_error", "Vercel 500", "vercel", 500)
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    // pollVercelDeployment must not have been called at all
    expect(mockPollVercelDeployment).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});
