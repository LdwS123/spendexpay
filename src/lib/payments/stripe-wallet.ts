/**
 * Shared helper for Stripe-backed wallet providers (Apple Pay, Google Pay).
 *
 * Both wallets follow the same approval-link pattern:
 *   1. Create an unconfirmed Stripe PaymentIntent
 *   2. Build a Spendex-hosted approval URL using intent.id (NOT client_secret)
 *   3. Return outcome="pending" so the agent surfaces the URL to the user
 *
 * IMPORTANT: The approval URL must use intent.id, never client_secret.
 * client_secret is a credential — any holder can confirm/cancel the PaymentIntent
 * without the server secret key. Agent frameworks log all tool outputs, making
 * any URL containing client_secret effectively public. The dashboard's /pay/[id]
 * route fetches client_secret server-side before passing it to Stripe.js.
 *
 * The only per-wallet differences are the `payment_ui` metadata tag and the
 * resulting `paymentMethod` on the ChargeResult — both are passed in.
 */

import { pendingApprovalResult } from "./internal.js";
import { stripeClient } from "./stripe.js";
import type { ChargeParams, PaymentMethod, PendingApprovalResult, ProviderCustomerId } from "./types.js";

const SPENDEX_PAYMENT_BASE_URL = process.env["SPENDEX_APP_URL"] ?? "https://spendexai.com";

export async function createWalletApprovalCharge(opts: {
  params: ChargeParams & { providerCustomerId: ProviderCustomerId };
  paymentMethod: PaymentMethod;
  // Tagged on the PaymentIntent metadata so dashboard analytics can attribute
  // charges to the specific wallet UI used.
  paymentUi: "apple_pay" | "google_pay";
}): Promise<PendingApprovalResult> {
  const { amountUsd, description, idempotencyKey, metadata, userId, providerCustomerId } = opts.params;

  const amountCents = Math.round(amountUsd * 100);

  // Create a PaymentIntent but do NOT confirm — the user must approve via the wallet.
  // payment_method_types=["card"] because both Apple Pay and Google Pay tokenize
  // into a card payment method on Stripe's side.
  const intent = await stripeClient.paymentIntents.create(
    {
      amount: amountCents,
      currency: "usd",
      customer: providerCustomerId as string,
      payment_method_types: ["card"],
      description,
      metadata: { ...metadata, spendex_user_id: userId, payment_ui: opts.paymentUi },
    },
    { idempotencyKey }
  );

  const approvalUrl = `${SPENDEX_PAYMENT_BASE_URL}/pay/${intent.id}`;

  return pendingApprovalResult(opts.paymentMethod, intent.id, approvalUrl);
}
