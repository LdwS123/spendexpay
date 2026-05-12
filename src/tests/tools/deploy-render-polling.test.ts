/**
 * Tests for polling behaviour wired into registerDeployRenderTool.
 *
 * We mock ../../lib/render.js with TWO independent functions so we can
 * control triggerRenderDeploy and pollRenderDeploy independently.
 *
 * All other I/O (DB, rate-limit, payment router) is mocked to the happy
 * path so each test focuses purely on the polling branch.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted before any imports that touch these modules.
// ---------------------------------------------------------------------------

const { mockTriggerRenderDeploy, mockPollRenderDeploy } = vi.hoisted(() => ({
  mockTriggerRenderDeploy: vi.fn(),
  mockPollRenderDeploy: vi.fn(),
}));

vi.mock("../../lib/render.js", () => ({
  triggerRenderDeploy: mockTriggerRenderDeploy,
  pollRenderDeploy: mockPollRenderDeploy,
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
import { registerDeployRenderTool } from "../../tools/deploy-render.js";
import { ProviderError } from "../../lib/provider-error.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = {
  id: "user_render_poll",
  email: "renderpoll@test.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_render_poll" as any,
  vercel_token: "vercel_tok",
  netlify_token: "nlf",
  railway_token: "rly",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd_tok_poll",
  max_auto_charge_usd: 50,
};

const MOCK_CHARGE = {
  outcome: "charged" as const,
  transactionId: "pi_render_poll_mock",
  paymentMethod: "stripe_card" as const,
};

// triggerRenderDeploy always resolves to this in the happy path
const TRIGGER_RESULT = {
  deployId: "dep_abc123",
  url: "https://dashboard.render.com/web/srv-original",
};

const INPUT = { service_id: "srv-poll123", mcp_token: "spx_render_poll_token" };

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
  registerDeployRenderTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockTriggerRenderDeploy.mockReset();
  mockPollRenderDeploy.mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(checkRateLimit).mockReset();

  // Happy-path defaults
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);

  // triggerRenderDeploy always succeeds in these tests (overridden per test where needed)
  mockTriggerRenderDeploy.mockResolvedValue(TRIGGER_RESULT);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy_to_render — polling integration", () => {
  it("1. Poll returns live → success response with URL", async () => {
    const polledUrl = "https://dashboard.render.com/web/srv-poll123";
    mockPollRenderDeploy.mockResolvedValue({ url: polledUrl, state: "live" });

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(polledUrl);
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("2. Poll throws ProviderError (build_failed) → deploy_failed_after_payment logged", async () => {
    mockPollRenderDeploy.mockRejectedValue(
      new ProviderError(
        "unknown",
        "Render deployment failed (status: build_failed). Check the Render dashboard for build logs.",
        "render"
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Render deploy failed/i);
    expect(result.content[0].text).toContain(
      "Render deployment failed (status: build_failed). Check the Render dashboard for build logs."
    );
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("3. Poll throws ProviderError (network) → deploy failure response", async () => {
    mockPollRenderDeploy.mockRejectedValue(
      new ProviderError(
        "network",
        "Could not reach render. Check your internet connection and try again.",
        "render"
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Render deploy failed/i);
    expect(result.content[0].text).toContain("Could not reach render");
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("4. Poll URL differs from trigger URL → final URL is from poll", async () => {
    const polledUrl = "https://dashboard.render.com/web/srv-poll123";
    // triggerRenderDeploy returns a different URL in TRIGGER_RESULT
    // poll returns the canonical URL — the tool must use the polled one
    mockPollRenderDeploy.mockResolvedValue({ url: polledUrl, state: "live" });

    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    // Final URL must be the polled URL, not the original trigger URL
    expect(result.content[0].text).toContain(polledUrl);
    expect(result.content[0].text).not.toContain("srv-original");
  });

  it("5. Trigger fails → poll never called", async () => {
    mockTriggerRenderDeploy.mockRejectedValue(
      new ProviderError("server_error", "Render 500", "render", 500)
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    // pollRenderDeploy must not have been called at all
    expect(mockPollRenderDeploy).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});
