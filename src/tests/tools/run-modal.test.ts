/**
 * Tests for src/tools/run-modal.ts — registerRunModalTool
 *
 * We mock all I/O (DB, rate-limit, payment router, Modal API) so no
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

vi.mock("../../lib/modal.js", () => ({
  runModalFunction: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { routePayment } from "../../lib/payments/router.js";
import { runModalFunction } from "../../lib/modal.js";
import { registerRunModalTool } from "../../tools/run-modal.js";
import { ProviderError } from "../../lib/provider-error.js";
import {
  createHandlerCapture,
  makeDeployUser,
  makeMockCharge,
} from "../fixtures.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = makeDeployUser({ modal_token: "modal_tok" });

const MOCK_CHARGE = makeMockCharge();

const MOCK_MODAL_RESULT = {
  callId: "call_abc123",
  outputSummary: "Function queued — check the Modal dashboard for output.",
  url: "https://modal.com/apps/my-app",
};

const INPUT = {
  app_name: "my-app",
  function_name: "run_inference",
  mcp_token: "spx_tok",
};

// ---------------------------------------------------------------------------
// Handler capture — registered once for all tests
// ---------------------------------------------------------------------------

const { mockServer, getHandler } = createHandlerCapture();

beforeAll(() => {
  registerRunModalTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mock state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(runModalFunction).mockReset();
  vi.mocked(logTransaction).mockReset();

  // Happy-path defaults — individual tests override what they need
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(runModalFunction).mockResolvedValue(MOCK_MODAL_RESULT);
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerRunModalTool — rate limit denied", () => {
  it("returns isError:true with 'Too many requests' when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfterMs: 5000,
    });

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many requests/);
    expect(result.content[0].text).toMatch(/5 second/);
  });
});

describe("registerRunModalTool — missing modal_token", () => {
  it("returns isError:true with 'not configured' when user has no modal_token", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      modal_token: "",
    } as any);

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not configured/);
    expect(result.content[0].text).toMatch(/Modal/);
  });
});

describe("registerRunModalTool — payment failure", () => {
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

describe("registerRunModalTool — Modal function fails after payment", () => {
  it("returns isError:true and logs deploy_failed_after_payment when runModalFunction throws a ProviderError auth", async () => {
    vi.mocked(runModalFunction).mockRejectedValue(
      new ProviderError(
        "auth",
        "Your Modal token is invalid or expired. Generate a new one at modal.com/settings and update it in your Spendex dashboard.",
        "modal",
        401
      )
    );

    const result = await getHandler()!(INPUT);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text.toLowerCase()).toMatch(/modal|run failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deploy_failed_after_payment" })
    );
  });
});

describe("registerRunModalTool — success", () => {
  it("returns the URL and callId in the response and logs success on a fully successful run", async () => {
    const result = await getHandler()!(INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("modal.com/apps/my-app");
    expect(text).toContain("call_abc123");

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });
});

describe("registerRunModalTool — invalid input_json", () => {
  it("returns isError:true with an error message when input_json is not valid JSON", async () => {
    vi.mocked(runModalFunction).mockRejectedValue(
      new ProviderError("unknown", "inputJson is not valid JSON.", "modal")
    );

    const result = await getHandler()!({ ...INPUT, input_json: "not-valid-json" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Modal run failed/);
  });
});
