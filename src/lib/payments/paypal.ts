/**
 * PayPal payment provider.
 * Uses PayPal REST API v2 with reference transactions (billing agreements).
 *
 * Flow for agent-initiated charges:
 *   - User links their PayPal account once in the Spendex dashboard
 *   - Spendex stores a billing_agreement_id for that user
 *   - On each charge, we create an order and immediately capture it
 *     against the saved billing agreement (no user present needed)
 *
 * Test mode: use sandbox credentials from developer.paypal.com
 * Sandbox base URL: https://api-m.sandbox.paypal.com
 * Production URL:   https://api-m.paypal.com
 *
 * Docs: https://developer.paypal.com/docs/api/orders/v2/
 */

import { config } from "../../config.js";
import { chargedResult, parseJsonOrThrow } from "./internal.js";
import type { ChargeParams, ChargeResult, PaymentProvider, ProviderCustomerId } from "./types.js";

const PAYPAL_API_BASE = config.paypal.sandbox
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";

// Refresh the cached token slightly before its real expiry so an in-flight
// charge never races against expiration mid-request.
const TOKEN_EXPIRY_SAFETY_WINDOW_MS = 60_000;

interface PayPalTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface PayPalCapture {
  id: string;
  status: string;
}

interface PayPalOrderResponse {
  id: string;
  status: string;
  purchase_units: Array<{ payments?: { captures?: PayPalCapture[] } }>;
}

// Module-level cache so multiple PayPalProvider instances (or repeated charges)
// reuse one OAuth token until it nears expiry. PayPal tokens are valid for
// ~9 hours; refetching on every charge wastes a roundtrip and rate-limit budget.
let cachedToken: { value: string; expiresAt: number } | null = null;
let inflightTokenFetch: Promise<string> | null = null;

export class PayPalProvider implements PaymentProvider {
  readonly method = "paypal" as const;

  async charge(
    params: ChargeParams & { providerCustomerId: ProviderCustomerId }
  ): Promise<ChargeResult> {
    const { amountUsd, description, idempotencyKey, providerCustomerId } = params;

    const accessToken = await getAccessToken();

    // Step 1: Create the order against the user's saved billing agreement
    const order = await this.createOrder({
      accessToken,
      amountUsd,
      description,
      idempotencyKey,
      billingAgreementId: providerCustomerId as string, // stored during PayPal onboarding
    });

    // Step 2: Immediately capture payment (reference transaction — no redirect needed)
    const capture = await this.captureOrder({ accessToken, orderId: order.id, idempotencyKey });

    // Verify the capture actually completed. PayPal can return a 200 OK with
    // a capture in "PENDING" or "DECLINED" state — a non-200 response would
    // have already thrown, but we must check the inner capture status here.
    const captureRecord = capture.purchase_units?.[0]?.payments?.captures?.[0];

    if (!captureRecord) {
      throw new Error(
        `PayPal capture response is missing capture record. Order ID: ${order.id}. ` +
        `The order may be in status "${capture.status}" — check the PayPal dashboard.`
      );
    }

    if (captureRecord.status !== "COMPLETED") {
      throw new Error(
        `PayPal capture did not complete. Capture ID: ${captureRecord.id}, ` +
        `status: "${captureRecord.status}", Order ID: ${order.id}. ` +
        `Check the PayPal dashboard for details.`
      );
    }

    return chargedResult("paypal", captureRecord.id);
  }

  private async createOrder(params: {
    accessToken: string;
    amountUsd: number;
    description: string;
    idempotencyKey: string;
    billingAgreementId: string;
  }): Promise<PayPalOrderResponse> {
    const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": params.idempotencyKey,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: "USD",
              value: params.amountUsd.toFixed(2),
            },
            description: params.description,
          },
        ],
        payment_source: {
          // Reference transaction: charge the saved billing agreement directly
          paypal: { billing_agreement_id: params.billingAgreementId },
        },
      }),
    });

    return parseJsonOrThrow<PayPalOrderResponse>(response, "PayPal", "order creation");
  }

  private async captureOrder(params: {
    accessToken: string;
    orderId: string;
    idempotencyKey: string;
  }): Promise<PayPalOrderResponse> {
    const response = await fetch(
      `${PAYPAL_API_BASE}/v2/checkout/orders/${params.orderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": `${params.idempotencyKey}-capture`,
        },
      }
    );

    return parseJsonOrThrow<PayPalOrderResponse>(response, "PayPal", "capture");
  }
}

/**
 * Return a valid OAuth access token, fetching a new one only when the cached
 * one is missing or about to expire.
 *
 * Exported so the PayPal webhook handler can reuse the same token cache when
 * calling the webhook signature verification API. Both the charge path and the
 * webhook path share the same client credentials, so sharing the cache avoids
 * redundant token fetches.
 *
 * Concurrent callers share a single in-flight fetch (`inflightTokenFetch`)
 * so the first charge after expiry doesn't trigger N parallel auth requests.
 */
export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }
  if (inflightTokenFetch) {
    return inflightTokenFetch;
  }

  inflightTokenFetch = fetchAccessToken().finally(() => {
    inflightTokenFetch = null;
  });
  return inflightTokenFetch;
}

async function fetchAccessToken(): Promise<string> {
  const credentials = Buffer.from(
    `${config.paypal.clientId}:${config.paypal.clientSecret}`
  ).toString("base64");

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await parseJsonOrThrow<PayPalTokenResponse>(response, "PayPal", "auth");

  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_SAFETY_WINDOW_MS,
  };
  return data.access_token;
}
