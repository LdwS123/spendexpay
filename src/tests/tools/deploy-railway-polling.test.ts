/**
 * Tests for polling behaviour wired into registerDeployRailwayTool.
 *
 * We mock ../../lib/railway.js with TWO independent functions so we can
 * control triggerRailwayDeploy and pollRailwayDeployment independently.
 *
 * All other I/O (DB, rate-limit, payment router) is mocked to the happy
 * path so each test focuses purely on the polling branch.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted before any imports that touch these modules.
// ---------------------------------------------------------------------------

const { mockTriggerRailwayDeploy, mockPollRailwayDeployment } = vi.hoisted(() => ({
  mockTriggerRailwayDeploy: vi.fn(),
  mockPollRailwayDeployment: vi.fn(),
}));

vi.mock("../../lib/railway.js", () => ({
  triggerRailwayDeploy: mockTriggerRailwayDeploy,
  pollRailwayDeployment: mockPollRailwayDeployment,
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
import { registerDeployRailwayTool } from "../../tools/deploy-railway.js";
import { ProviderError } from "../../lib/provider-error.js";
import {
  createHandlerCapture,
  makeDeployUser,
  makeMockCharge,
} from "../fixtures.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = makeDeployUser({
  id: "user_rly_poll",
  email: "poll@railway.test",
  payment_provider_customer_id: "cus_rly_poll" as any,
  vercel_token: "v",
  netlify_token: "nlf",
  railway_token: "rly_tok_poll",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd",
});

const MOCK_CHARGE = makeMockCharge({ transactionId: "pi_rly_poll_mock" });

// triggerRailwayDeploy always resolves to this in the happy path
const TRIGGER_RESULT = {
  deploymentId: "dep-railway-abc123",
  url: "https://railway.app/dashboard",
};

const INPUT = { service_id: "srv-poll-abc", mcp_token: "spx_rly_poll_token" };

// ---------------------------------------------------------------------------
// Handler capture
// ---------------------------------------------------------------------------

const { mockServer, getHandler } = createHandlerCapture();

beforeAll(() => {
  registerDeployRailwayTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockTriggerRailwayDeploy.mockReset();
  mockPollRailwayDeployment.mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(checkRateLimit).mockReset();

  // Happy-path defaults
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);

  // triggerRailwayDeploy always succeeds in these tests
  mockTriggerRailwayDeploy.mockResolvedValue(TRIGGER_RESULT);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy_to_railway — polling integration", () => {
  it("1. Poll returns SUCCESS → success response contains the polled URL", async () => {
    const polledUrl = "https://my-service.railway.app";
    mockPollRailwayDeployment.mockResolvedValue({ url: polledUrl, state: "SUCCESS" });

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(polledUrl);
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("2. Poll throws ProviderError (FAILED) → deploy_failed_after_payment logged", async () => {
    mockPollRailwayDeployment.mockRejectedValue(
      new ProviderError(
        "unknown",
        "Railway deployment failed (status: FAILED). Check your Railway dashboard.",
        "railway"
      )
    );

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Railway deploy failed/i);
    expect(result.content[0].text).toContain(
      "Railway deployment failed (status: FAILED). Check your Railway dashboard."
    );
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("3. Poll timeout → deploy failure response", async () => {
    mockPollRailwayDeployment.mockRejectedValue(
      new ProviderError(
        "unknown",
        "Railway deployment timed out after 120s.",
        "railway"
      )
    );

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Railway deploy failed/i);
    expect(result.content[0].text).toContain("timed out after 120s");
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("4. URL comes from poll not trigger → final URL is the polled URL", async () => {
    const polledUrl = "https://polled-service.railway.app";
    // TRIGGER_RESULT has url: "https://railway.app/dashboard" — poll returns a different one
    mockPollRailwayDeployment.mockResolvedValue({ url: polledUrl, state: "SUCCESS" });

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBeUndefined();
    // Final URL must be the polled URL, not the trigger URL
    expect(result.content[0].text).toContain(polledUrl);
    expect(result.content[0].text).not.toContain("railway.app/dashboard");
  });

  it("5. Trigger fails → poll never called", async () => {
    mockTriggerRailwayDeploy.mockRejectedValue(
      new ProviderError("server_error", "Railway 503", "railway", 503)
    );

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    // pollRailwayDeployment must not have been called at all
    expect(mockPollRailwayDeployment).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});
