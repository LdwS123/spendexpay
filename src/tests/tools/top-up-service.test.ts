/**
 * Tests for src/tools/top-up-service.ts — registerTopUpServiceTool
 *
 * We mock all I/O (DB, rate-limit, payment router) so no network calls
 * or real Stripe/Supabase connections are made.
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

vi.mock("../../config.js", () => {
  const cfg = { emergencyStop: false };
  return { config: cfg, DEV_MODE: false };
});

vi.mock("../../lib/payments/router.js", () => ({
  routePayment: vi.fn(),
}));

vi.mock("../../lib/idempotency.js", () => ({
  acquireIdempotencyKey: vi.fn(),
  releaseIdempotencyKey: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { config } from "../../config.js";
import { routePayment } from "../../lib/payments/router.js";
import { acquireIdempotencyKey } from "../../lib/idempotency.js";
import { registerTopUpServiceTool } from "../../tools/top-up-service.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = {
  id: "user_456",
  email: "dev@example.com",
  payment_method: "stripe_card" as const,
  payment_provider_customer_id: "cus_topup" as any,
  vercel_token: "v",
  netlify_token: "nlf",
  railway_token: "rly",
  fly_token: "fly",
  replicate_token: "rep",
  render_token: "rnd",
  modal_token: "modal_tok",
  max_auto_charge_usd: 100,
};

const MOCK_CHARGE = {
  outcome: "charged" as const,
  transactionId: "pi_mock_topup",
  paymentMethod: "stripe_card" as const,
};

const INPUT = {
  service_name: "modal",
  amount_usd: 50,
  mcp_token: "spx_test_token",
};

// ---------------------------------------------------------------------------
// Handler capture — registered once for all tests
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
  registerTopUpServiceTool(mockServer as any);
});

// ---------------------------------------------------------------------------
// Reset mock state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(getUserByMcpToken).mockReset();
  vi.mocked(routePayment).mockReset();
  vi.mocked(logTransaction).mockReset();
  vi.mocked(acquireIdempotencyKey).mockReset();

  // Ensure emergencyStop is false before every test
  (config as any).emergencyStop = false;

  // Happy-path defaults — individual tests override what they need
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getUserByMcpToken).mockResolvedValue(MOCK_USER as any);
  vi.mocked(routePayment).mockResolvedValue(MOCK_CHARGE);
  vi.mocked(logTransaction).mockResolvedValue(undefined as any);
  vi.mocked(acquireIdempotencyKey).mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerTopUpServiceTool — rate limit denied", () => {
  it("returns isError:true with retryAfterMs in message when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfterMs: 12000,
    });

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many requests/);
    expect(result.content[0].text).toMatch(/12 second/);
  });
});

describe("registerTopUpServiceTool — emergency stop", () => {
  it("returns isError:true with maintenance message when emergencyStop is true", async () => {
    (config as any).emergencyStop = true;

    const result = await handler!(INPUT);

    (config as any).emergencyStop = false;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/maintenance/i);
  });
});

describe("registerTopUpServiceTool — invalid MCP token", () => {
  it("returns isError:true with 'Invalid or expired' when getUserByMcpToken returns null", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue(null as any);

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid or expired/);
  });
});

describe("registerTopUpServiceTool — amount exceeds auto-approve limit", () => {
  it("returns an informational message (no isError) when amount_usd exceeds max_auto_charge_usd", async () => {
    vi.mocked(getUserByMcpToken).mockResolvedValue({
      ...MOCK_USER,
      max_auto_charge_usd: 25,
    } as any);

    const result = await handler!({ ...INPUT, amount_usd: 50 });

    // No isError flag — this is a limit check, not an infrastructure error
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/auto-approve limit/);
    expect(result.content[0].text).toMatch(/\$25/);
  });
});

describe("registerTopUpServiceTool — duplicate in-flight request", () => {
  it("returns isError:true when idempotency key is already held (in-flight)", async () => {
    vi.mocked(acquireIdempotencyKey).mockReturnValue(false);

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already in progress/);
  });
});

describe("registerTopUpServiceTool — payment failure", () => {
  it("returns isError:true with 'Payment failed' and logs payment_failed when routePayment throws", async () => {
    vi.mocked(routePayment).mockRejectedValue(new Error("Insufficient funds"));

    const result = await handler!(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Payment failed/);

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "payment_failed",
        transactionType: "top_up",
      })
    );
  });
});

describe("registerTopUpServiceTool — success", () => {
  it("returns confirmation with transaction ID and logs success with transactionType 'top_up'", async () => {
    const result = await handler!(INPUT);

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("pi_mock_topup");
    expect(text).toContain("$50.00");
    expect(text).toContain("modal");

    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        transactionType: "top_up",
        service: "modal",
        amountUsd: 50,
      })
    );
  });
});

describe("registerTopUpServiceTool — routePayment receives correct metadata", () => {
  it("passes transactionType 'top_up' and service metadata to routePayment", async () => {
    await handler!(INPUT);

    expect(vi.mocked(routePayment)).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionType: "top_up",
        metadata: expect.objectContaining({
          service: "modal",
          transaction_type: "top_up",
        }),
      })
    );
  });
});

describe("registerTopUpServiceTool — different services", () => {
  it("works for openai service with correct description and log entry", async () => {
    const result = await handler!({
      service_name: "openai",
      amount_usd: 20,
      mcp_token: "spx_tok",
    });

    expect(result.isError).toBeUndefined();
    expect(vi.mocked(logTransaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "openai",
        transactionType: "top_up",
        amountUsd: 20,
      })
    );
  });
});
