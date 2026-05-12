/**
 * Tests for polling behaviour wired into registerDeployFlyioTool.
 *
 * We mock ../../lib/flyio.js with TWO independent functions so we can
 * control triggerFlyDeploy and pollFlyDeployment independently.
 *
 * All other I/O (DB, rate-limit, payment router) is mocked to the happy
 * path so each test focuses purely on the polling branch.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted before any imports that touch these modules.
// ---------------------------------------------------------------------------

const { mockTriggerFlyDeploy, mockPollFlyDeployment } = vi.hoisted(() => ({
  mockTriggerFlyDeploy: vi.fn(),
  mockPollFlyDeployment: vi.fn(),
}));

vi.mock("../../lib/flyio.js", () => ({
  triggerFlyDeploy: mockTriggerFlyDeploy,
  pollFlyDeployment: mockPollFlyDeployment,
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
import { registerDeployFlyioTool } from "../../tools/deploy-flyio.js";
import { ProviderError } from "../../lib/provider-error.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = {
  id: "user_fly_poll",
  email: "poll@fly.test",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_fly_poll" as any,
  vercel_token: "v",
  netlify_token: "nlf",
  railway_token: "rly",
  fly_token: "fly_tok_poll",
  replicate_token: "rep",
  render_token: "rnd",
  max_auto_charge_usd: 50,
};

const MOCK_CHARGE = {
  outcome: "charged" as const,
  transactionId: "pi_fly_poll_mock",
  paymentMethod: "stripe_card" as const,
};

// triggerFlyDeploy always resolves to this in the happy path
const TRIGGER_RESULT = {
  releaseId: "42",
  url: "https://my-poll-app.fly.dev",
};

const INPUT = { app_name: "my-poll-app", mcp_token: "spx_fly_poll_token" };

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
  registerDeployFlyioTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockTriggerFlyDeploy.mockReset();
  mockPollFlyDeployment.mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(checkRateLimit).mockReset();

  // Happy-path defaults
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);

  // triggerFlyDeploy always succeeds in these tests
  mockTriggerFlyDeploy.mockResolvedValue(TRIGGER_RESULT);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy_to_flyio — polling integration", () => {
  it("1. Poll returns complete → success response contains the polled URL", async () => {
    const polledUrl = "https://my-poll-app.fly.dev";
    mockPollFlyDeployment.mockResolvedValue({ url: polledUrl, state: "complete" });

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(polledUrl);
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("2. Poll throws ProviderError (failed) → deploy_failed_after_payment logged", async () => {
    mockPollFlyDeployment.mockRejectedValue(
      new ProviderError(
        "unknown",
        "Fly.io deployment failed. Check `flyctl logs` for details.",
        "flyio"
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Fly\.io deploy failed/i);
    expect(result.content[0].text).toContain(
      "Fly.io deployment failed. Check `flyctl logs` for details."
    );
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("3. Poll timeout → deploy failure response", async () => {
    mockPollFlyDeployment.mockRejectedValue(
      new ProviderError(
        "unknown",
        "Fly.io deployment timed out after 120s.",
        "flyio"
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Fly\.io deploy failed/i);
    expect(result.content[0].text).toContain("timed out after 120s");
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("4. URL comes from poll not trigger → final URL is the polled URL", async () => {
    const polledUrl = "https://polled-distinct-url.fly.dev";
    // TRIGGER_RESULT has url: "https://my-poll-app.fly.dev" — poll returns a different one
    mockPollFlyDeployment.mockResolvedValue({ url: polledUrl, state: "complete" });

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    // Final URL must be the polled URL, not the original trigger URL
    expect(result.content[0].text).toContain(polledUrl);
    expect(result.content[0].text).not.toContain("my-poll-app.fly.dev");
  });

  it("5. Trigger fails → poll never called", async () => {
    mockTriggerFlyDeploy.mockRejectedValue(
      new ProviderError("server_error", "Fly.io 500", "flyio", 500)
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    // pollFlyDeployment must not have been called at all
    expect(mockPollFlyDeployment).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});
