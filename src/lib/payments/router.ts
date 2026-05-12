import { AchBankTransferProvider } from "./ach.js";
import { ApplePayProvider } from "./apple-pay.js";
import { CoinbaseCommerceProvider } from "./coinbase.js";
import { GooglePayProvider } from "./google-pay.js";
import { freeResult } from "./internal.js";
import { PayPalProvider } from "./paypal.js";
import { StripeProvider } from "./stripe.js";
import { UsdcBaseProvider } from "./usdc-base.js";
import type {
  ChargeParams,
  ChargeResult,
  PaymentMethod,
  PaymentProvider,
  ProviderCustomerId,
} from "./types.js";

const providers: Record<PaymentMethod, PaymentProvider> = {
  stripe_card:        new StripeProvider(),
  paypal:             new PayPalProvider(),
  ach_bank_transfer:  new AchBankTransferProvider(),
  coinbase_commerce:  new CoinbaseCommerceProvider(),
  usdc_base:          new UsdcBaseProvider(),
  apple_pay:          new ApplePayProvider(),
  google_pay:         new GooglePayProvider(),
};

interface RoutePaymentParams extends ChargeParams {
  paymentMethod: PaymentMethod;
  providerCustomerId: ProviderCustomerId;
}

export async function routePayment(params: RoutePaymentParams): Promise<ChargeResult> {
  const provider = providers[params.paymentMethod];

  if (!provider) {
    throw new Error(
      `Payment method "${params.paymentMethod}" is not supported. ` +
      `Available: ${Object.keys(providers).join(", ")}`
    );
  }

  // Free-tier actions never reach the provider — return a synthetic audit-log entry.
  if (params.amountUsd === 0) {
    return freeResult(params.paymentMethod, params.idempotencyKey);
  }

  return provider.charge(params);
}
