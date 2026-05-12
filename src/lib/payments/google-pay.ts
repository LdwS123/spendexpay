/**
 * Google Pay provider.
 *
 * Same approval-link pattern as Apple Pay — Google Pay requires browser
 * confirmation and cannot run directly inside an MCP stdio server.
 *
 * The user taps the returned approvalUrl, confirms with Google Pay in
 * their browser, and Stripe completes the PaymentIntent via webhook.
 *
 * For instant charges without user interaction, use stripe_card,
 * paypal, ach_bank_transfer, or usdc_base instead.
 *
 * Google Pay setup:
 *   - Register at pay.google.com/business/console
 *   - Enable Google Pay in Stripe dashboard settings
 *
 * Implementation lives in stripe-wallet.ts — see ApplePayProvider for context.
 */

import { createWalletApprovalCharge } from "./stripe-wallet.js";
import type { ChargeParams, ChargeResult, PaymentProvider, ProviderCustomerId } from "./types.js";

export class GooglePayProvider implements PaymentProvider {
  readonly method = "google_pay" as const;

  async charge(
    params: ChargeParams & { providerCustomerId: ProviderCustomerId }
  ): Promise<ChargeResult> {
    return createWalletApprovalCharge({
      params,
      paymentMethod: "google_pay",
      paymentUi: "google_pay",
    });
  }
}
