/**
 * Tests for src/tools/deploy-netlify.ts — registerDeployNetlifyTool
 *
 * We mock all I/O (DB, rate-limit, payment router, Netlify API) so no
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

const { mockPollNetlifyDeploy } = vi.hoisted(() => ({
  mockPollNetlifyDeploy: vi.fn(),
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

vi.mock("../../lib/netlify.js", () => ({
  triggerNetlifyDeploy: vi.fn(),
  pollNetlifyDeploy: mockPollNetlifyDeploy,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { routePayment } from "../../lib/payments/router.js";
import { triggerNetlifyDeploy } from "../../lib/netlify.js";
import { registerDeployNetlifyTool } from "../../tools/deploy-netlify.js";
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
  deployId: "deploy_abc",
  url: "https://my-site.netlify.app",
};

const INPUT = { site_id: "my-site-123", mcp_token: "spx_tok" };

// ---------------------------------------------------------------------------
// Handler capture — registered once for all tests
// ---------------------------------------------------------------------------

const { mockServer, getHandler } = createHandlerCapture();

beforeAll(() => {
  registerDeployNetlifyTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mock state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(triggerNetlifyDeploy).mockReset();
  mockPollNetlifyDeploy.mockReset();
  vi.mocked(logTransaction).mockReset();

  // Happy-path defaults — individual tests override what they need
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(triggerNetlifyDeploy).mockResolvedValue(MOCK_DEPLOY_RESULT);
  mockPollNetlifyDeploy.mockResolvedValue({ url: MOCK_DEPLOY_RESULT.url, state: "READY" });
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerDeployNetlifyTool — rate limit denied", () => {
  it("returns isError:true with 'Too many requests' when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfterMs: 5000,
    });

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many requests/);
    // The retryAfterMs value must be surfaced to the caller
    expect(result.content[0].text).toMatch(/5 second/);
  });
});

describe("registerDeployNetlifyTool — emergency stop", () => {
  it("returns isError:true with 'paused' when emergencyStop is true", async () => {
    // Override the module-level config object for this test only
    const configMod = await import("../../config.js");
    (configMod.config as any).emergencyStop = true;

    const result = await getHandler()!(INPUT);

    // Restore to default so other tests aren't affected
    (configMod.config as any).emergencyStop = false;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/paused/);
  });
});

describe("registerDeployNetlifyTool — invalid MCP token", () => {
  it("returns isError:true with 'Invalid or expired' when getUserByMcpToken returns null", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue(null as any);

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid or expired/);
  });
});

describe("registerDeployNetlifyTool — missing Netlify token", () => {
  it("returns isError:true with 'No Netlify token' when user has no netlify_token", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      netlify_token: "",
    } as any);

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No Netlify token/);
  });
});

describe("registerDeployNetlifyTool — payment failure", () => {
  it("returns isError:true with 'Payment failed' and logs payment_failed when routePayment throws", async () => {
    vi.mocked(routePayment).mockRejectedValue(new Error("Card declined"));

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Payment failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "payment_failed" })
    );
  });
});

describe("registerDeployNetlifyTool — deploy failure after payment", () => {
  it("returns isError:true referencing Netlify and logs deploy_failed_after_payment when triggerNetlifyDeploy throws", async () => {
    vi.mocked(triggerNetlifyDeploy).mockRejectedValue(
      new Error("Netlify API error 500: Internal Server Error")
    );

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    // The error message must mention deploy failure context
    const text = result.content[0].text;
    expect(text.toLowerCase()).toMatch(/netlify|deploy failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});

describe("registerDeployNetlifyTool — success", () => {
  it("returns the deployment URL and logs success on a fully successful deploy", async () => {
    const result = await getHandler()!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("my-site.netlify.app");

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });
});
