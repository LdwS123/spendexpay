/**
 * Edge-case tests for provider-level error scenarios in deploy-vercel tool.
 *
 * Covers the full set of ProviderError codes (auth, not_found, quota,
 * conflict, rate_limit, server_error, network), max_auto_charge enforcement,
 * and plain (non-ProviderError) exceptions thrown from the provider lib.
 *
 * We deliberately avoid importing ProviderError directly in the mock
 * factories — instead we construct tagged error objects via
 *   Object.assign(new Error("msg"), { code: "auth", name: "ProviderError" })
 * This keeps the mocks functional even when provider-error.ts is being
 * modified in parallel by another agent.
 *
 * Handler captured via mockServer.tool, same pattern as deploy-vercel.test.ts
 * and deploy-netlify.test.ts.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted — mock functions that must be available inside vi.mock factories
// ---------------------------------------------------------------------------

const { mockTriggerVercelDeploy, mockPollVercelDeployment } = vi.hoisted(() => ({
  mockTriggerVercelDeploy: vi.fn(),
  mockPollVercelDeployment: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — hoisted by Vitest; must come before any real imports
// ---------------------------------------------------------------------------

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
  triggerVercelDeploy: mockTriggerVercelDeploy,
  pollVercelDeployment: mockPollVercelDeployment,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import { routePayment } from "../../lib/payments/router.js";
import { registerDeployVercelTool } from "../../tools/deploy-vercel.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a tagged error object that mimics ProviderError without importing it. */
function providerErr(
  code: string,
  message: string,
  provider = "vercel",
  statusCode?: number
) {
  return Object.assign(new Error(message), {
    name: "ProviderError",
    code,
    provider,
    statusCode,
  });
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = {
  id: "user_abc",
  email: "dev@example.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_test" as any,
  vercel_token: "vercel_tok_xyz",
  netlify_token: "nlf",
  railway_token: "rly",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd",
  max_auto_charge_usd: 50,
};

const MOCK_CHARGE = {
  outcome: "charged" as const,
  transactionId: "pi_mock_edge",
  paymentMethod: "stripe_card" as const,
};

const INPUT = { project_name: "edge-app", mcp_token: "spx_" + "e".repeat(32) };

// ---------------------------------------------------------------------------
// Handler capture — registered once for all tests in this file
// ---------------------------------------------------------------------------

type HandlerFn = (
  input: any
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

let handler: HandlerFn | undefined;

const mockServer = { tool: vi.fn() };

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (_name: string, _desc: string, _schema: any, h: HandlerFn) => {
      handler = h;
    }
  );
  registerDeployVercelTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mocks before each test — happy-path defaults applied here so each
// test only needs to override the specific behaviour it wants to exercise.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  mockTriggerVercelDeploy.mockReset();
  mockPollVercelDeployment.mockReset();
  vi.mocked(logTransaction).mockReset();

  // Ensure emergencyStop is off before every test
  (config as any).emergencyStop = false;

  // Happy-path defaults — individual tests override what they need
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  mockTriggerVercelDeploy.mockResolvedValue({
    url: "https://edge-app.vercel.app",
    deploymentId: "dpl_edge_ok",
  });
  mockPollVercelDeployment.mockResolvedValue({
    url: "https://edge-app.vercel.app",
    state: "READY",
  });
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
});

// ---------------------------------------------------------------------------
// 1. Token expired / invalid (auth error — 401)
// ---------------------------------------------------------------------------

describe("provider-errors — token expired (auth / 401)", () => {
  it("returns isError:true with message about invalid or expired token", async () => {
    mockTriggerVercelDeploy.mockRejectedValue(
      providerErr(
        "auth",
        "Your Vercel token is invalid or expired. Generate a new one at vercel.com/account/tokens and update it in your Spendex dashboard.",
        "vercel",
        401
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // The error message from the ProviderError is passed through verbatim
    expect(text).toMatch(/invalid or expired/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Project not found (404)
// ---------------------------------------------------------------------------

describe("provider-errors — project not found (404)", () => {
  it("returns isError:true with message containing 'not found'", async () => {
    mockTriggerVercelDeploy.mockRejectedValue(
      providerErr(
        "not_found",
        "Project not found on vercel. Verify the project name/ID matches exactly and your token has access to it.",
        "vercel",
        404
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Plan quota exceeded (402)
// ---------------------------------------------------------------------------

describe("provider-errors — plan quota exceeded (402)", () => {
  it("returns isError:true with message about plan limits", async () => {
    mockTriggerVercelDeploy.mockRejectedValue(
      providerErr(
        "quota",
        "Your vercel plan has reached its usage limits. Upgrade your plan or wait for the monthly reset.",
        "vercel",
        402
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/plan|limit/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Already deploying / conflict (409)
// ---------------------------------------------------------------------------

describe("provider-errors — already deploying (conflict / 409)", () => {
  it("returns isError:true with message about deployment in progress", async () => {
    mockTriggerVercelDeploy.mockRejectedValue(
      providerErr(
        "conflict",
        "A deployment is already in progress on vercel. Wait for it to complete before retrying.",
        "vercel",
        409
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/in progress|already/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Rate limited by provider (429)
// ---------------------------------------------------------------------------

describe("provider-errors — rate limited by provider (429)", () => {
  it("returns isError:true after the provider signals rate-limit exhaustion", async () => {
    mockTriggerVercelDeploy.mockRejectedValue(
      providerErr(
        "rate_limit",
        "You are being rate limited by vercel. Wait a few seconds and try again.",
        "vercel",
        429
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    // The message from ProviderError must reach the caller
    expect(result.content[0].text).toMatch(/rate limit|wait/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Server error (5xx)
// ---------------------------------------------------------------------------

describe("provider-errors — provider server error (5xx)", () => {
  it("returns isError:true with message about temporary unavailability", async () => {
    mockTriggerVercelDeploy.mockRejectedValue(
      providerErr(
        "server_error",
        "The vercel service is temporarily unavailable (error 503). Try again in a moment.",
        "vercel",
        503
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/temporarily unavailable|try again/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Network error (no connectivity)
// ---------------------------------------------------------------------------

describe("provider-errors — network error", () => {
  it("returns isError:true with message about connectivity", async () => {
    mockTriggerVercelDeploy.mockRejectedValue(
      providerErr(
        "network",
        "Could not reach vercel. Check your internet connection and try again.",
        "vercel"
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/vercel|connection|internet|reach/i);
  });
});

// ---------------------------------------------------------------------------
// 8. max_auto_charge exceeded
//
// VERCEL_DEPLOY_COST_USD is 0 in the tool, so the payment router would never
// enforce a charge limit on the deploy-vercel tool itself. However, routePayment
// is responsible for enforcing the user's max_auto_charge_usd threshold, and it
// is expected to throw if the requested charge exceeds it. We test that path
// here by making routePayment throw with a message that surfaces the limit,
// which the handler must relay to the caller under "payment_failed".
// ---------------------------------------------------------------------------

describe("provider-errors — max_auto_charge exceeded", () => {
  it("returns isError:true with message about auto-approve limit when routePayment rejects with limit error", async () => {
    vi.mocked(routePayment).mockRejectedValue(
      new Error(
        "Charge of $10.00 exceeds your auto-approve limit of $1.00. Update your limit at spendexai.com/settings."
      )
    );

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // The payment failure path surfaces the underlying error message
    expect(text).toMatch(/auto-approve limit|exceeds|limit/i);

    // The audit log must record the payment failure
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "payment_failed" })
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Generic plain Error (not a ProviderError) thrown by the provider lib
// ---------------------------------------------------------------------------

describe("provider-errors — generic unknown error from provider", () => {
  it("returns isError:true and surfaces the error message when a plain Error is thrown", async () => {
    const rawMessage =
      "Unexpected failure in deployment pipeline: checksum mismatch";
    mockTriggerVercelDeploy.mockRejectedValue(new Error(rawMessage));

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    // The handler's errorMessage() helper extracts err.message from plain Errors
    expect(result.content[0].text).toContain(rawMessage);

    // The audit log must be attempted with deploy_failed_after_payment
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});

// ---------------------------------------------------------------------------
// Sanity: confirm the happy path still works in this test module
// ---------------------------------------------------------------------------

describe("provider-errors — baseline happy path (sanity check)", () => {
  it("returns the deployment URL and logs success when all providers succeed", async () => {
    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("edge-app.vercel.app");

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });
});
