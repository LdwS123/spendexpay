import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken, logTransaction } from "../lib/db.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { triggerFlyDeploy, pollFlyDeployment } from "../lib/flyio.js";
import { ProviderError } from "../lib/provider-error.js";

const DeployFlyioInput = z.object({
  app_name: z.string().min(1).describe("Your Fly.io app name (as shown in fly.toml or the Fly dashboard)"),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
});

// Fly.io charges usage separately (compute, bandwidth) — not per deploy trigger.
// Update this value if Spendex begins metering deploy events independently.
const FLYIO_DEPLOY_COST_USD = 0;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

export function registerDeployFlyioTool(server: McpServer) {
  server.tool(
    "deploy_to_flyio",
    "[Legacy fallback — prefer pay_for_service for new integrations] Trigger a Fly.io application deployment on behalf of the user. Handles payment automatically.",
    DeployFlyioInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] deploy_to_flyio called.\n` +
          `App: ${input.app_name}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method, trigger a Fly.io deploy, and return the app URL.\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
        );
      }

      // Checked before authentication intentionally: this prevents a caller
      // from probing token validity via timing differences (an invalid token
      // is rate-limited at the same rate as a valid one), and it protects the
      // database from being hammered by a runaway agent with any token.
      const rateLimit = checkRateLimit(input.mcp_token);
      if (!rateLimit.allowed) {
        const waitSeconds = Math.ceil((rateLimit.retryAfterMs ?? 0) / 1000);
        return textResponse(
          `Too many requests. Please wait ${waitSeconds} second${waitSeconds === 1 ? "" : "s"} before trying again.`,
          { isError: true }
        );
      }

      if (config.emergencyStop) {
        return textResponse(
          "Spendex Pay is temporarily paused for maintenance. Please try again later or deploy manually.",
          { isError: true }
        );
      }

      const user = await getUserByMcpToken(input.mcp_token);
      if (!user) {
        return textResponse(
          "Invalid or expired MCP token. Please reconnect at spendexai.com/connect.",
          { isError: true }
        );
      }

      if (!user.fly_token) {
        return textResponse(
          "No Fly.io token found on your account. Add your Fly.io token at spendexai.com/connect.",
          { isError: true }
        );
      }

      // If there's a cost AND the user's auto-approve threshold is non-zero AND
      // the cost exceeds the threshold → refuse and tell the agent to ask the user.
      if (
        FLYIO_DEPLOY_COST_USD > 0 &&
        user.max_auto_charge_usd > 0 &&
        FLYIO_DEPLOY_COST_USD > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This action would charge $${FLYIO_DEPLOY_COST_USD.toFixed(2)} but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      const deployDescription = `Fly.io deploy: ${input.app_name}`;
      // Include a millisecond timestamp so each deploy attempt gets a unique
      // idempotency key. A day-granular key would cause Stripe to cache the result
      // of the first attempt and return it (including a "failed" status) for all
      // retries within the same calendar day, preventing recovery from failures.
      const idempotencyKey = `${user.id}-flyio-${input.app_name}-${Date.now()}`;

      let transactionId: string | null = null;

      try {
        const charge = await routePayment({
          userId: user.id,
          paymentMethod: user.payment_method,
          providerCustomerId: user.payment_provider_customer_id,
          amountUsd: FLYIO_DEPLOY_COST_USD,
          description: deployDescription,
          idempotencyKey,
          metadata: {
            service: "flyio",
            app: input.app_name,
          },
        });

        transactionId = charge.transactionId;
      } catch (err) {
        const message = errorMessage(err, "Unknown payment error");
        await logTransaction({
          userId: user.id,
          service: "flyio",
          status: "payment_failed",
          amountUsd: FLYIO_DEPLOY_COST_USD,
          description: deployDescription,
          error: message,
        });

        return textResponse(
          `Payment failed: ${message}. Your account was not charged. Check your payment method at spendexai.com/billing.`,
          { isError: true }
        );
      }

      let deploymentUrl: string;

      try {
        const deployment = await triggerFlyDeploy({
          appName: input.app_name,
          flyToken: user.fly_token,
        });

        const polled = await pollFlyDeployment(
          deployment.releaseId,
          input.app_name,
          user.fly_token
        );

        deploymentUrl = polled.url;
      } catch (deployErr) {
        // logTransaction throws when status="deploy_failed_after_payment" and the
        // DB write fails — that error message already includes the transaction ID
        // and instructs the user to contact support. We must NOT swallow it here.
        const deployMessage = deployErr instanceof ProviderError
          ? deployErr.message
          : errorMessage(deployErr, "Unknown deploy error");
        let auditLogError: Error | null = null;

        try {
          await logTransaction({
            userId: user.id,
            service: "flyio",
            status: "deploy_failed_after_payment",
            amountUsd: FLYIO_DEPLOY_COST_USD,
            transactionId: transactionId ?? undefined,
            description: deployDescription,
            error: deployMessage,
          });
        } catch (logErr) {
          auditLogError = logErr instanceof Error ? logErr : new Error(String(logErr));
        }

        // IMPORTANT: We intentionally do NOT say "payment voided" here.
        // The charge has already succeeded against the payment provider and
        // we have not issued a refund. If FLYIO_DEPLOY_COST_USD is ever
        // non-zero, the support team must issue a manual refund using
        // transactionId. The user is told to contact support for this reason.
        const txn = transactionId ?? "unknown";
        const chargeNote =
          FLYIO_DEPLOY_COST_USD > 0
            ? ` Your account was charged $${FLYIO_DEPLOY_COST_USD.toFixed(2)} (transaction: ${txn}). Contact support at spendexai.com/support to request a refund.`
            : " (No charge was made for this deploy.)";

        const auditNote = auditLogError
          ? ` WARNING: The audit log could not be written (${auditLogError.message}). This charge is not recorded — contact support immediately with transaction ID: ${txn}.`
          : "";

        return textResponse(
          `Fly.io deploy failed: ${deployMessage}.${chargeNote}${auditNote}`,
          { isError: true }
        );
      }

      await logTransaction({
        userId: user.id,
        service: "flyio",
        status: "success",
        amountUsd: FLYIO_DEPLOY_COST_USD,
        transactionId: transactionId ?? undefined,
        description: deployDescription,
      });

      return textResponse(`Deployed successfully. App URL: ${deploymentUrl}`);
    }
  );
}
