export type PaymentMethod =
  | "stripe_card"
  | "paypal"
  | "ach_bank_transfer"
  | "coinbase_commerce"
  | "usdc_base"
  | "apple_pay"
  | "google_pay";

// Branded provider customer IDs.
// Each payment provider uses a fundamentally different namespace for the
// "customer" concept. A bare string would let a Stripe customer ID be silently
// passed to PayPal, and vice versa. Brands encode the namespace at the type
// level so mismatches are caught at compile time.
//
// Create values at trust boundaries with the cast helpers below:
//   const id = stripeCustomerId(rawString);

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

/** Stripe customer ID — format "cus_…" */
export type StripeCustomerId = Brand<string, "StripeCustomerId">;
/** Stripe PaymentMethod ID for a saved US bank account — format "pm_…" */
export type StripeAchPaymentMethodId = Brand<string, "StripeAchPaymentMethodId">;
/** PayPal billing agreement ID — format "B-…" */
export type PayPalBillingAgreementId = Brand<string, "PayPalBillingAgreementId">;
/** Circle (Programmable Wallets) wallet ID — UUID */
export type CircleWalletId = Brand<string, "CircleWalletId">;

export type ProviderCustomerId =
  | StripeCustomerId
  | StripeAchPaymentMethodId
  | PayPalBillingAgreementId
  | CircleWalletId;

/** Cast helpers — call at trust boundaries (DB reads, env var reads). */
export const stripeCustomerId = (s: string): StripeCustomerId =>
  s as StripeCustomerId;
export const stripeAchPaymentMethodId = (s: string): StripeAchPaymentMethodId =>
  s as StripeAchPaymentMethodId;
export const payPalBillingAgreementId = (s: string): PayPalBillingAgreementId =>
  s as PayPalBillingAgreementId;
export const circleWalletId = (s: string): CircleWalletId =>
  s as CircleWalletId;

export interface ChargeParams {
  userId: string;
  amountUsd: number;
  description: string;
  // Format: {userId}-{service}-{uniqueContext}
  // Prevents double-charges when the agent retries a failed call.
  idempotencyKey: string;
  metadata: Record<string, string>;
  // Transaction classification — recorded in audit_logs for reporting.
  // Optional so existing callers (deploy_to_vercel, run_modal, etc.) compile unchanged.
  transactionType?: string;
  // Identifier of the AI agent that initiated this charge (e.g. "claude-code", "cursor").
  // Optional — only set when the caller provides it.
  agentId?: string;
}

// ChargeResult — discriminated union.
//
// Three mutually exclusive outcomes from a charge() call:
//
//   "charged"  — money moved immediately (Stripe, PayPal, ACH, crypto).
//                approvalUrl is absent — there is nothing for the user to do.
//
//   "pending"  — charge initiated but requires the user to approve via a
//                browser UI (Apple Pay, Google Pay). The agent MUST surface
//                approvalUrl to the user before the payment can complete.
//                approvalUrl is required (never optional) in this outcome.
//
//   "free"     — amountUsd was $0. No payment provider was called and no
//                money moved. Used for free-tier actions that still need
//                an audit-log entry.
//
// Invariant: `outcome === "pending"` ↔ `approvalUrl` is present.
// This invariant is structural — it cannot be violated by construction.

interface ChargeResultBase {
  transactionId: string;
  paymentMethod: PaymentMethod;
}

export interface ChargedResult extends ChargeResultBase {
  outcome: "charged";
}

export interface PendingApprovalResult extends ChargeResultBase {
  outcome: "pending";
  /** URL the agent must show the user to complete payment in their browser. */
  approvalUrl: string;
}

export interface FreeResult extends ChargeResultBase {
  outcome: "free";
}

export type ChargeResult = ChargedResult | PendingApprovalResult | FreeResult;

export interface PaymentProvider {
  readonly method: PaymentMethod;
  charge(params: ChargeParams & { providerCustomerId: ProviderCustomerId }): Promise<ChargeResult>;
}
