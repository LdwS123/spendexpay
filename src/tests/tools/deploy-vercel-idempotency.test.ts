/**
 * Tests for the in-flight idempotency guard wired into registerDeployVercelTool.
 *
 * We mock ../../lib/idempotency.js so we can control acquireIdempotencyKey's
 * return value per test. All other I/O is mocked to the happy path.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted so vi.mock() can reference them
// ---------------------------------------------------------------------------

const {
  mockAcquireIdempotencyKey,
  mockReleaseIdempotencyKey,
  mockTriggerVercelDeploy,
  mockPollVercelDeployment,
} = vi.hoisted(() => ({
  mockAcquireIdempotencyKey: vi.fn(),
  mockReleaseIdempotencyKey: vi.fn(),
  mockTriggerVercelDeploy: vi.fn(),
  mockPollVercelDeployment: vi.fn(),
}));

vi.mock("../../lib/idempotency.js", () => ({
  acquireIdempotencyKey: mockAcquireIdempotencyKey,
  releaseIdempotencyKey: mockReleaseIdempotencyKey,
  getInFlightCount: vi.fn().mockReturnValue(0),
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
  triggerVercelDeploy: mockTriggerVercelDeploy,
  pollVercelDeployment: mockPollVercelDeployment,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { routePayment } from "../../lib/payments/router.js";
import { registerDeployVercelTool } from "../../tools/deploy-vercel.js";
import {
  createHandlerCapture,
  makeDeployUser,
  makeMockCharge,
} from "../fixtures.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = makeDeployUser({
  id: "user_idem",
  email: "idem@test.com",
  payment_provider_customer_id: "cus_idem" as any,
  vercel_token: "vercel_tok_idem",
  netlify_token: "nlf",
  railway_token: "rly",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd",
});

const MOCK_CHARGE = makeMockCharge({ transactionId: "pi_idem_mock" });

const MOCK_DEPLOY_RESULT = {
  deploymentId: "dpl_idem",
  url: "https://idem-app.vercel.app",
};

const INPUT = { project_name: "idem-app", mcp_token: "spx_" + "c".repeat(32) };

// ---------------------------------------------------------------------------
// Handler capture — registered once for all tests
// ---------------------------------------------------------------------------

const { mockServer, getHandler } = createHandlerCapture();

beforeAll(() => {
  registerDeployVercelTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockAcquireIdempotencyKey.mockReset();
  mockReleaseIdempotencyKey.mockReset();
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
  mockTriggerVercelDeploy.mockResolvedValue(MOCK_DEPLOY_RESULT);
  mockPollVercelDeployment.mockResolvedValue({
    url: "https://idem-app.vercel.app",
    state: "READY",
  });

  // By default: key is free to acquire
  mockAcquireIdempotencyKey.mockReturnValue(true);
  mockReleaseIdempotencyKey.mockReturnValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy_to_vercel — idempotency guard", () => {
  it("1. First call proceeds normally and returns a success response", async () => {
    mockAcquireIdempotencyKey.mockReturnValue(true);

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("idem-app.vercel.app");
    expect(vi.mocked(routePayment)).toHaveBeenCalledOnce();
    expect(mockReleaseIdempotencyKey).toHaveBeenCalledOnce();
  });

  it("2. Immediate second call with same project returns 'already in progress' and does not call routePayment", async () => {
    // Simulate key already held by first in-flight request
    mockAcquireIdempotencyKey.mockReturnValue(false);

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already in progress/i);
    expect(vi.mocked(routePayment)).not.toHaveBeenCalled();
    // releaseIdempotencyKey must NOT be called — we never acquired the lock
    expect(mockReleaseIdempotencyKey).not.toHaveBeenCalled();
  });

  it("3. After first call completes, second call proceeds normally (routePayment is called)", async () => {
    // First call: key acquired and released (handler runs to completion)
    mockAcquireIdempotencyKey.mockReturnValue(true);
    await getHandler()!(INPUT);

    // Reset call counts for the second call
    vi.mocked(routePayment).mockClear();
    mockAcquireIdempotencyKey.mockClear();
    mockReleaseIdempotencyKey.mockClear();

    // Second call: key is free again (first call released it)
    mockAcquireIdempotencyKey.mockReturnValue(true);
    const result = await getHandler()!(INPUT);

    expect(result.isError).toBeUndefined();
    expect(vi.mocked(routePayment)).toHaveBeenCalledOnce();
    expect(mockReleaseIdempotencyKey).toHaveBeenCalledOnce();
  });
});
