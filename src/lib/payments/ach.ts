/**
 * ACH bank transfer provider (via Stripe ACH Debit).
 *
 * ACH is US bank-to-bank transfer — no card, no crypto. Lower fees than cards
 * (~0.8% capped at $5 vs 2.9% for cards), but 1-3 business day settlement.
 * Good for larger amounts where the fee saving matters.
 *
 * Flow:
 *   - User links their bank account once via Stripe's Plaid-powered flow
 *   - Stripe stores a payment_method ID with type=us_bank_account
 *   - We create a PaymentIntent with that saved method and confirm off-session
 *
 * Note: ACH can fail days later (insufficient funds, account closed).
 * The PaymentIntent will have status=requires_action or fail asynchronously.
 * Handle this via Stripe webhooks in the dashboard app.
 *
 * Test mode: use test routing/account numbers from Stripe docs:
 * https://stripe.com/docs/ach-debit/testing
 */

import { chargedResult } from "./internal.js";
import { stripeClient } from "./stripe.js";
import type { ChargeParams, ChargeResult, PaymentProvider, ProviderCustomerId } from "./types.js";

export class AchBankTransferProvider implements PaymentProvider {
  readonly method = "ach_bank_transfer" as const;

  async charge(
    params: ChargeParams & { providerCustomerId: ProviderCustomerId }
  ): Promise<ChargeResult> {
    const { amountUsd, description, idempotencyKey, metadata, userId, providerCustomerId } = params;

    const amountCents = Math.round(amountUsd * 100);

    // providerCustomerId is the Stripe payment_method ID for the saved bank account
    const intent = await stripeClient.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        payment_method: providerCustomerId as string,
        payment_method_types: ["us_bank_account"],
        confirm: true,
        off_session: true,
        description,
        metadata: { ...metadata, spendex_user_id: userId },
        // Mandate data required by Stripe for ACH debit authorization
        mandate_data: {
          customer_acceptance: {
            type: "online",
            online: {
              // 127.0.0.1 = this MCP server runs locally on the user's machine.
              // 0.0.0.0 is a reserved address that fails ACH dispute defense.
              ip_address: "127.0.0.1",
              user_agent: "SpendexPay-MCP/0.1",
            },
          },
        },
      },
      { idempotencyKey }
    );

    // ACH settlement takes 1-3 business days — the expected terminal status
    // after a successful off-session confirm is "processing", not "succeeded".
    // "succeeded" would mean the bank confirmed instantly, which is rare.
    // A status of "requires_payment_method" or "requires_action" means the
    // debit was rejected or the mandate is invalid — those must fail hard.
    // Final success confirmation comes via Stripe webhook (payment_intent.succeeded).
    if (intent.status !== "processing" && intent.status !== "succeeded") {
      throw new Error(
        `ACH debit was not accepted. PaymentIntent ${intent.id} is in status "${intent.status}". ` +
        `The bank account may be invalid or the mandate was not accepted. ` +
        `Check the Stripe dashboard: https://dashboard.stripe.com/payments/${intent.id}`
      );
    }

    return chargedResult("ach_bank_transfer", intent.id);
  }
}
