/**
 * Internal helpers shared across payment providers.
 *
 * Not part of the public payments API — only the provider implementations
 * and the router import from here. Keeps each provider file focused on its
 * own provider-specific logic.
 */

import type {
  ChargedResult,
  FreeResult,
  PaymentMethod,
  PendingApprovalResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Result builders
//
// Centralizing these keeps the discriminated-union shape consistent and
// avoids each provider hand-constructing the literal `outcome` strings.
// ---------------------------------------------------------------------------

export function chargedResult(
  paymentMethod: PaymentMethod,
  transactionId: string
): ChargedResult {
  return { outcome: "charged", paymentMethod, transactionId };
}

export function pendingApprovalResult(
  paymentMethod: PaymentMethod,
  transactionId: string,
  approvalUrl: string
): PendingApprovalResult {
  return { outcome: "pending", paymentMethod, transactionId, approvalUrl };
}

export function freeResult(
  paymentMethod: PaymentMethod,
  idempotencyKey: string
): FreeResult {
  return {
    outcome: "free",
    paymentMethod,
    transactionId: `free-${idempotencyKey}`,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
//
// All provider HTTP calls follow the same pattern: throw on non-2xx with a
// consistent error format, then parse JSON. Centralizing these gives every
// provider the same "<Provider> <action> failed: <status> <body>" message.
// ---------------------------------------------------------------------------

/**
 * Throw a uniform error if the response is not OK; otherwise parse JSON
 * as the caller-supplied type.
 *
 * The cast is unchecked — providers should only pass response shapes they
 * already validate by reading well-known fields. The branded `as T` lives
 * here (one place) instead of being repeated in every provider.
 */
export async function parseJsonOrThrow<T>(
  response: Response,
  provider: string,
  action: string
): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${provider} ${action} failed: ${response.status} ${body}`);
  }
  return (await response.json()) as T;
}

