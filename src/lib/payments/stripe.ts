/**
 * Stripe payment provider.
 * Handles card payments (credit/debit, Apple Pay, Google Pay via Stripe).
 *
 * Uses PaymentIntents with off_session=true — the correct Stripe pattern
 * for agent-initiated charges where no user is present in a browser.
 */

import Stripe from "stripe";
import { config } from "../../config.js";
import { chargedResult } from "./internal.js";
import type { ChargeParams, ChargeResult, PaymentProvider, ProviderCustomerId } from "./types.js";

let _stripeClient: Stripe | undefined;
function getStripeClient(): Stripe {
  if (!_stripeClient) {
    _stripeClient = new Stripe(config.stripe.secretKey, { apiVersion: "2024-06-20" });
  }
  return _stripeClient;
}
export const stripeClient = new Proxy({} as Stripe, {
  get: (_, prop) => Reflect.get(getStripeClient(), prop),
});

export class StripeProvider implements PaymentProvider {
  readonly method = "stripe_card" as const;

  async charge(
    params: ChargeParams & { providerCustomerId: ProviderCustomerId }
  ): Promise<ChargeResult> {
    const { amountUsd, description, idempotencyKey, metadata, userId, providerCustomerId } = params;

    // Stripe amounts are in the smallest currency unit (cents for USD).
    // The router has already short-circuited the $0 case.
    const amountCents = Math.round(amountUsd * 100);

    const intent = await stripeClient.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        customer: providerCustomerId as string,
        confirm: true,
        off_session: true,
        description,
        metadata: { ...metadata, spendex_user_id: userId },
      },
      { idempotencyKey }
    );

    // Only "succeeded" means the charge actually completed. Any other status
    // (e.g. "requires_action", "requires_payment_method", "processing") means
    // the funds have not been captured. Treat all non-succeeded states as
    // failures so we never deliver service without confirmed payment.
    if (intent.status !== "succeeded") {
      throw new Error(
        `Stripe charge did not succeed. PaymentIntent ${intent.id} is in status "${intent.status}". ` +
        `This may require further action from the user (e.g. 3DS authentication). ` +
        `Check the Stripe dashboard: https://dashboard.stripe.com/payments/${intent.id}`
      );
    }

    return chargedResult("stripe_card", intent.id);
  }
}
