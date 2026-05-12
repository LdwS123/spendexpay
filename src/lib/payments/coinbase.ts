/**
 * Coinbase Commerce payment provider.
 * Accepts BTC, ETH, USDC, DAI, and other supported cryptocurrencies.
 *
 * Flow for agent-initiated payments:
 *   1. Spendex creates a charge on Coinbase Commerce API
 *   2. Coinbase returns a hosted payment URL + charge ID
 *   3. The user has pre-funded a wallet linked to their Spendex account
 *   4. Coinbase confirms payment via webhook (see dashboard app for webhook handler)
 *   5. We poll the charge status here to confirm before returning to the agent
 *
 * Test mode: use COINBASE_COMMERCE_API_KEY from the sandbox environment at
 * commerce.coinbase.com — no real crypto is moved in sandbox mode.
 *
 * Docs: https://docs.cdp.coinbase.com/commerce/docs/
 */

import { config } from "../../config.js";
import { chargedResult, parseJsonOrThrow } from "./internal.js";
import type { ChargeParams, ChargeResult, PaymentProvider, ProviderCustomerId } from "./types.js";

const COINBASE_COMMERCE_API = "https://api.commerce.coinbase.com";

// How long to wait for a crypto payment to confirm before timing out.
// Crypto confirmations can take seconds (USDC on Base) to minutes (ETH mainnet).
const PAYMENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 5_000; // check every 5 seconds

type CoinbaseChargeStatus =
  | "NEW"
  | "PENDING"
  | "COMPLETED"
  | "EXPIRED"
  | "UNRESOLVED"
  | "RESOLVED"
  | "CANCELED";

// Distinguish between the three ways pollUntilConfirmed can stop:
// - "confirmed": payment completed
// - "terminal_failure": charge definitively expired or canceled — do not retry
// - "timeout": deadline passed but charge may still be live — operator must investigate
type PollResult = "confirmed" | "terminal_failure" | "timeout";

interface CoinbaseCharge {
  id: string;
  code: string;
  hosted_url: string;
  timeline: Array<{ status: CoinbaseChargeStatus }>;
}

export class CoinbaseCommerceProvider implements PaymentProvider {
  readonly method = "coinbase_commerce" as const;

  async charge(
    params: ChargeParams & { providerCustomerId: ProviderCustomerId }
  ): Promise<ChargeResult> {
    const { amountUsd, description, idempotencyKey, metadata, userId } = params;

    // Create the charge on Coinbase Commerce
    const charge = await this.createCharge({
      amountUsd,
      description,
      idempotencyKey,
      metadata: { ...metadata, spendex_user_id: userId },
    });

    // Wait for the user's wallet to complete the payment.
    // In a real agentic flow, the user's wallet is pre-configured to
    // auto-pay Spendex charges below their configured limit.
    const pollResult = await this.pollUntilConfirmed(charge.id);

    if (pollResult === "terminal_failure") {
      throw new Error(
        `Crypto payment was declined or expired before funds arrived. ` +
        `Charge ID: ${charge.code}. ` +
        `Create a new charge to try again, or complete payment manually at: ${charge.hosted_url}`
      );
    }

    if (pollResult === "timeout") {
      // The charge is still open on Coinbase — the user's wallet may complete it
      // after we return. This is a dangerous state: we must NOT deliver service,
      // and we must NOT assume the charge failed. The operator must reconcile via webhook.
      throw new Error(
        `Crypto payment confirmation timed out after ${PAYMENT_TIMEOUT_MS / 1000}s. ` +
        `Charge ID: ${charge.code} is still open — it may complete after this timeout. ` +
        `Do NOT retry immediately. Monitor the Coinbase Commerce dashboard or webhook ` +
        `events to determine whether payment completed before retrying.`
      );
    }

    return chargedResult("coinbase_commerce", charge.id);
  }

  private async createCharge(params: {
    amountUsd: number;
    description: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<CoinbaseCharge> {
    const response = await fetch(`${COINBASE_COMMERCE_API}/charges`, {
      method: "POST",
      headers: {
        "X-CC-Api-Key": config.coinbase.commerceApiKey,
        "X-CC-Version": "2018-03-22",
        "Content-Type": "application/json",
        // Coinbase Commerce uses idempotency keys to deduplicate charge creation
        "X-Idempotency-Key": params.idempotencyKey,
      },
      body: JSON.stringify({
        name: "Spendex Pay",
        description: params.description,
        pricing_type: "fixed_price",
        local_price: {
          amount: params.amountUsd.toFixed(2),
          currency: "USD",
        },
        metadata: params.metadata,
      }),
    });

    const body = await parseJsonOrThrow<{ data: CoinbaseCharge }>(
      response,
      "Coinbase Commerce",
      "charge creation"
    );
    return body.data;
  }

  private async pollUntilConfirmed(chargeId: string): Promise<PollResult> {
    const deadline = Date.now() + PAYMENT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      let status: CoinbaseChargeStatus;

      try {
        status = await this.getChargeStatus(chargeId);
      } catch (err) {
        // A network error or API error during polling is not itself a payment
        // failure — the charge may still complete on-chain. Log and keep polling
        // until the deadline so transient connectivity issues don't abort a
        // payment that was already broadcast to the blockchain.
        console.error(
          `[coinbase] Error polling charge ${chargeId}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Continuing to poll — ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s remaining.`
        );
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      if (status === "COMPLETED" || status === "RESOLVED") return "confirmed";
      // EXPIRED and CANCELED are terminal — Coinbase will not accept funds for this charge.
      if (status === "EXPIRED" || status === "CANCELED") return "terminal_failure";

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return "timeout"; // deadline passed; charge is still open on Coinbase
  }

  private async getChargeStatus(chargeId: string): Promise<CoinbaseChargeStatus> {
    const response = await fetch(`${COINBASE_COMMERCE_API}/charges/${chargeId}`, {
      headers: {
        "X-CC-Api-Key": config.coinbase.commerceApiKey,
        "X-CC-Version": "2018-03-22",
      },
    });

    const body = await parseJsonOrThrow<{ data: CoinbaseCharge }>(
      response,
      "Coinbase Commerce",
      `fetch charge ${chargeId}`
    );

    // A charge with an empty timeline is still in its initial state.
    const timeline = body.data.timeline;
    if (!timeline || timeline.length === 0) return "NEW";
    return timeline[timeline.length - 1].status;
  }
}
