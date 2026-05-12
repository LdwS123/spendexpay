/**
 * USDC on Base payment provider (via Circle Programmable Wallets API).
 *
 * Base is Coinbase's L2 chain — USDC transfers cost ~$0.01 and confirm in seconds.
 * This is the best rail for small, frequent dev tool payments.
 *
 * We use Circle's Programmable Wallets so users don't manage private keys themselves:
 *   - User creates a Circle wallet during Spendex onboarding (custodial, PIN-protected)
 *   - They deposit USDC into it once
 *   - We transfer USDC from their wallet to the Spendex treasury wallet on each charge
 *
 * Circle sandbox: https://console-sandbox.circle.com
 * Circle docs: https://developers.circle.com/w3s/docs/programmable-wallets-overview
 *
 * To convert USDC received to USD for paying Vercel/etc., use Circle's
 * Business Account to off-ramp USDC → bank (1-2 day settlement, no gas fees).
 */

import { config } from "../../config.js";
import { chargedResult, parseJsonOrThrow } from "./internal.js";
import type { ChargeParams, ChargeResult, PaymentProvider, ProviderCustomerId } from "./types.js";

const CIRCLE_API_BASE = config.circle.sandbox
  ? "https://api-sandbox.circle.com"
  : "https://api.circle.com";

// USDC has 6 decimal places (1 USDC = 1_000_000 base units)
const USDC_DECIMALS = 6;

interface CircleTransferResponse {
  data: {
    id: string;
    state: "running" | "complete" | "failed";
  };
}

// Distinguish between the three ways pollUntilComplete can stop:
// - "complete": transfer confirmed on-chain
// - "failed": Circle reported a definitive failure (e.g. insufficient balance)
// - "timeout": deadline passed but transfer may still be in-flight on Base L2
type PollResult = "complete" | "failed" | "timeout";

export class UsdcBaseProvider implements PaymentProvider {
  readonly method = "usdc_base" as const;

  async charge(
    params: ChargeParams & { providerCustomerId: ProviderCustomerId }
  ): Promise<ChargeResult> {
    const { amountUsd, idempotencyKey, providerCustomerId } = params;

    // Convert USD amount to USDC base units (6 decimals)
    const usdcAmount = (amountUsd * Math.pow(10, USDC_DECIMALS)).toFixed(0);

    const transfer = await this.createTransfer({
      sourceWalletId: providerCustomerId as string, // user's Circle wallet ID
      destinationWalletId: config.circle.treasuryWalletId,
      usdcAmount,
      idempotencyKey,
    });

    // Circle transfers on Base are near-instant — poll briefly for confirmation
    const pollResult = await this.pollUntilComplete(transfer.data.id);

    if (pollResult === "failed") {
      // Circle has definitively marked this transfer as failed (e.g. insufficient
      // balance, wallet not found). It is safe to tell the user and let them retry.
      throw new Error(
        `USDC transfer failed. Transfer ID: ${transfer.data.id}. ` +
        `Possible causes: insufficient USDC balance in your wallet, invalid wallet configuration. ` +
        `Check your wallet balance at spendexai.com/billing and try again.`
      );
    }

    if (pollResult === "timeout") {
      // The transfer may still confirm on Base L2 after we return. We must NOT
      // deliver service and must NOT assume failure. The operator must reconcile
      // via Circle webhooks or by polling the transfer ID out-of-band.
      throw new Error(
        `USDC transfer confirmation timed out after 30s. Transfer ID: ${transfer.data.id} ` +
        `is still in-flight on Base L2. Do NOT retry immediately — the transfer may complete ` +
        `shortly. Monitor Circle webhooks or check the Circle dashboard before retrying.`
      );
    }

    return chargedResult("usdc_base", transfer.data.id);
  }

  private async createTransfer(params: {
    sourceWalletId: string;
    destinationWalletId: string;
    usdcAmount: string;
    idempotencyKey: string;
  }): Promise<CircleTransferResponse> {
    const response = await fetch(`${CIRCLE_API_BASE}/v1/w3s/wallets/${params.sourceWalletId}/transfers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.circle.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotencyKey: params.idempotencyKey,
        destinationAddress: params.destinationWalletId,
        amounts: [{ amount: params.usdcAmount, token: "USDC" }],
        blockchain: "BASE",
      }),
    });

    return parseJsonOrThrow<CircleTransferResponse>(response, "Circle", "USDC transfer");
  }

  private async pollUntilComplete(transferId: string): Promise<PollResult> {
    const deadline = Date.now() + 30_000; // Base L2 confirms in seconds
    const interval = 2_000;

    while (Date.now() < deadline) {
      let response: Response;

      try {
        response = await fetch(`${CIRCLE_API_BASE}/v1/w3s/transfers/${transferId}`, {
          headers: { Authorization: `Bearer ${config.circle.apiKey}` },
        });
      } catch (err) {
        // Network-level error (DNS failure, connection refused, etc.).
        // The transfer may still be processing on-chain — keep polling.
        console.error(
          `[usdc-base] Network error polling transfer ${transferId}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Continuing to poll — ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s remaining.`
        );
        await new Promise((resolve) => setTimeout(resolve, interval));
        continue;
      }

      if (!response.ok) {
        // HTTP error from Circle API (e.g. 401, 429, 500). Log it explicitly —
        // previously this was silently swallowed and the loop would time out
        // with no indication that a persistent API error was the real cause.
        const body = await response.text().catch(() => "(could not read body)");
        console.error(
          `[usdc-base] Circle API returned ${response.status} while polling transfer ${transferId}: ${body}. ` +
          `Continuing to poll — ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s remaining.`
        );
        await new Promise((resolve) => setTimeout(resolve, interval));
        continue;
      }

      const data = (await response.json()) as CircleTransferResponse;

      if (data.data.state === "complete") return "complete";
      // "failed" is a definitive terminal state from Circle — the transfer will not recover.
      if (data.data.state === "failed") return "failed";
      // "running" means the transaction is still being processed on-chain — keep polling.

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    return "timeout"; // deadline passed; transfer is still in-flight
  }
}
