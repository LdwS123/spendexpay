/**
 * Shared test fixtures.
 *
 * Extracted boilerplate from src/tests/**\/*.test.ts. Each helper here is
 * intentionally small and pure — no module-level side effects, no calls into
 * `vi` that would change reset semantics between tests. Tests still own their
 * own `vi.mock(...)` calls (those are hoisted and module-path-sensitive, so
 * they cannot be relocated to a shared file).
 *
 * Three helpers:
 *
 *   makeDeployUser(overrides?)   — the canonical user shape used by every
 *                                  deploy_to_* test. Token values are placeholders
 *                                  and can be overridden per test.
 *
 *   makeMockCharge(overrides?)   — the canonical `routePayment` success result
 *                                  used by the deploy/run tests.
 *
 *   createHandlerCapture<T>()    — factory that produces a `mockServer` and a
 *                                  `getHandler()` getter. Mirrors the
 *                                  `mockServer = { tool: vi.fn() }` +
 *                                  `mockServer.tool.mockImplementation(...)`
 *                                  pattern duplicated across 30+ files.
 *
 * If you find yourself reaching for `vi.mock(...)` in this file: stop. That
 * does not work here — vi.mock paths are resolved relative to the calling file
 * and the call must be at the top of that file for hoisting.
 */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// User fixture — used by every deploy_to_* / run_* tool test
// ---------------------------------------------------------------------------

/**
 * Returns a user object shaped like the rows the deploy-tool handlers expect
 * from `getUserByMcpToken`. Tests typically pass this through
 * `mockResolvedValue(makeDeployUser() as any)`.
 *
 * All token fields are non-empty placeholder strings so handlers that gate on
 * "has token" pass by default. Override any field via the `overrides` arg.
 */
export function makeDeployUser<T extends Record<string, unknown> = {}>(
  overrides?: T,
) {
  return {
    id: "user_123",
    email: "t@t.com",
    payment_method: "stripe_card" as const,
    payment_provider_customer_id: "cus_test" as any,
    vercel_token: "v",
    netlify_token: "nlf_tok",
    railway_token: "rly_tok",
    fly_token: "fly_tok",
    replicate_token: "rep_tok",
    render_token: "rnd_tok",
    max_auto_charge_usd: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Charge fixture — the shape of a successful routePayment() result
// ---------------------------------------------------------------------------

/**
 * Returns a `routePayment` success result. The `transactionId` defaults to
 * `"pi_mock"`; deploy-polling tests override it (e.g. `"pi_poll_mock"`) to
 * make assertion error messages clearer.
 */
export function makeMockCharge<T extends Record<string, unknown> = {}>(
  overrides?: T,
) {
  return {
    outcome: "charged" as const,
    transactionId: "pi_mock",
    paymentMethod: "stripe_card" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Handler capture — the mock McpServer pattern
// ---------------------------------------------------------------------------

/**
 * The shape every tool handler returns. Matches McpServer.tool's expected
 * handler signature for our tools (text content only).
 */
export type ToolHandler<TInput = any> = (
  input: TInput,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: any;
  _meta?: any;
}>;

/**
 * Factory for the "capture the handler passed to mockServer.tool" pattern.
 *
 * Usage:
 *
 *   const { mockServer, getHandler } = createHandlerCapture();
 *   beforeAll(() => { registerMyTool(mockServer as any); });
 *
 *   // inside a test:
 *   const result = await getHandler()!(INPUT);
 *
 * `getHandler()` returns the captured handler, or `undefined` if the
 * registration function hasn't run yet. Calling `getHandler()!(...)` matches
 * the existing `handler!(INPUT)` idiom.
 */
export function createHandlerCapture<TInput = any>() {
  let handler: ToolHandler<TInput> | undefined;

  const mockServer = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: any, h: ToolHandler<TInput>) => {
        handler = h;
      },
    ),
  };

  return {
    mockServer,
    getHandler: () => handler,
  };
}
