/**
 * Apple Pay provider.
 *
 * Apple Pay requires Touch ID / Face ID confirmation from the user's device.
 * This cannot happen inside an MCP stdio server — there is no browser or
 * native UI available.
 *
 * Instead, this provider uses the "approval link" pattern:
 *   1. We create a Stripe PaymentIntent with payment_method_types=["card"]
 *   2. We return an approvalUrl pointing to a hosted Spendex payment page
 *   3. The agent informs the user: "Tap here to approve with Apple Pay"
 *   4. After the user approves, the Stripe webhook confirms payment
 *   5. The agent polls or is notified to continue
 *
 * This is the correct pattern for any wallet that requires device-level auth.
 *
 * For instant charges without user interaction, the user should configure
 * stripe_card, paypal, or usdc_base instead.
 *
 * Apple Pay setup requires:
 *   - Domain verification file at /.well-known/apple-developer-merchantid-domain-association
 *   - Stripe Apple Pay configuration at dashboard.stripe.com/settings/payments
 *
 * Implementation lives in stripe-wallet.ts — Apple Pay and Google Pay differ
 * only in the `payment_ui` metadata tag and the returned `paymentMethod`.
 */

import { createWalletApprovalCharge } from "./stripe-wallet.js";
import type { ChargeParams, ChargeResult, PaymentProvider, ProviderCustomerId } from "./types.js";

export class ApplePayProvider implements PaymentProvider {
  readonly method = "apple_pay" as const;

  async charge(
    params: ChargeParams & { providerCustomerId: ProviderCustomerId }
  ): Promise<ChargeResult> {
    return createWalletApprovalCharge({
      params,
      paymentMethod: "apple_pay",
      paymentUi: "apple_pay",
    });
  }
}
