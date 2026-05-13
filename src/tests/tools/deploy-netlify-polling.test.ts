/**
 * Tests for polling behaviour wired into registerDeployNetlifyTool.
 *
 * We mock ../../lib/netlify.js with TWO independent functions so we can
 * control triggerNetlifyDeploy and pollNetlifyDeploy independently.
 *
 * All other I/O (DB, rate-limit, payment router) is mocked to the happy
 * path so each test focuses purely on the polling branch.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted before any imports that touch these modules.
// ---------------------------------------------------------------------------

const { mockTriggerNetlifyDeploy, mockPollNetlifyDeploy } = vi.hoisted(() => ({
  mockTriggerNetlifyDeploy: vi.fn(),
  mockPollNetlifyDeploy: vi.fn(),
}));

vi.mock("../../lib/netlify.js", () => ({
  triggerNetlifyDeploy: mockTriggerNetlifyDeploy,
  pollNetlifyDeploy: mockPollNetlifyDeploy,
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
import { registerDeployNetlifyTool } from "../../tools/deploy-netlify.js";
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
  id: "user_poll",
  email: "poll@test.com",
  payment_provider_customer_id: "cus_poll" as any,
  vercel_token: "v",
  netlify_token: "nlf_tok_poll",
  railway_token: "rly",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd",
});

const MOCK_CHARGE = makeMockCharge({ transactionId: "pi_poll_mock" });

// triggerNetlifyDeploy always resolves to this in the polling tests
const TRIGGER_RESULT = {
  deployId: "deploy_poll_123",
  url: "https://original-trigger.netlify.app",
};

const INPUT = { site_id: "my-poll-site", mcp_token: "spx_poll_token" };

// ---------------------------------------------------------------------------
// Handler capture
// ---------------------------------------------------------------------------

const { mockServer, getHandler } = createHandlerCapture();

beforeAll(() => {
  registerDeployNetlifyTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockTriggerNetlifyDeploy.mockReset();
  mockPollNetlifyDeploy.mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(checkRateLimit).mockReset();

  // Happy-path defaults
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);

  // triggerNetlifyDeploy always succeeds in these tests
  mockTriggerNetlifyDeploy.mockResolvedValue(TRIGGER_RESULT);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy_to_netlify — polling integration", () => {
  it("1. Poll returns ready → success response contains the polled URL", async () => {
    const polledUrl = "https://polled-ready.netlify.app";
    mockPollNetlifyDeploy.mockResolvedValue({ url: polledUrl, state: "ready" });

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(polledUrl);
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("2. Poll throws ProviderError code='unknown' (build failed) → tool returns deploy failure message and logs deploy_failed_after_payment", async () => {
    mockPollNetlifyDeploy.mockRejectedValue(
      new ProviderError(
        "unknown",
        "Netlify build failed. Check the Netlify dashboard for build logs at app.netlify.com.",
        "netlify"
      )
    );

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/netlify|deploy failed/i);
    expect(result.content[0].text).toContain(
      "Netlify build failed. Check the Netlify dashboard for build logs at app.netlify.com."
    );
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("3. Poll throws ProviderError code='network' → tool returns deploy failure message", async () => {
    mockPollNetlifyDeploy.mockRejectedValue(
      new ProviderError(
        "network",
        "Could not reach netlify. Check your internet connection and try again.",
        "netlify"
      )
    );

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/netlify|deploy failed/i);
    expect(result.content[0].text).toContain("Could not reach netlify");
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });

  it("4. Poll returns a different URL than trigger → final URL is from poll", async () => {
    const polledUrl = "https://final-from-poll.netlify.app";
    // triggerNetlifyDeploy returns "https://original-trigger.netlify.app"
    // poll returns a different URL — the tool must use the polled one
    mockPollNetlifyDeploy.mockResolvedValue({ url: polledUrl, state: "ready" });

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBeUndefined();
    // Final URL must be the polled URL, not the original trigger URL
    expect(result.content[0].text).toContain(polledUrl);
    expect(result.content[0].text).not.toContain("original-trigger.netlify.app");
  });

  it("5. trigger fails → poll is never called (trigger failure short-circuits before polling)", async () => {
    mockTriggerNetlifyDeploy.mockRejectedValue(
      new ProviderError("server_error", "Netlify 500", "netlify", 500)
    );

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    // pollNetlifyDeploy must not have been called at all
    expect(mockPollNetlifyDeploy).not.toHaveBeenCalled();
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});
