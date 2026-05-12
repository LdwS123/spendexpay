import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken, logTransaction } from "../lib/db.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { triggerRenderDeploy, pollRenderDeploy } from "../lib/render.js";
import { ProviderError } from "../lib/provider-error.js";

const DeployRenderInput = z.object({
  service_id: z.string().min(1).describe("Your Render service ID (found in the Render dashboard URL: dashboard.render.com/web/srv-xxx)"),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
});

const RENDER_DEPLOY_COST_USD = 0;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

export function registerDeployRenderTool(server: McpServer) {
  server.tool(
    "deploy_to_render",
    "[Legacy fallback — prefer pay_for_service for new integrations] Deploy a Render service on behalf of the user. Handles payment automatically.",
    DeployRenderInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] deploy_to_render called.\n` +
          `Service ID: ${input.service_id}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method, trigger a Render deploy, and return the dashboard URL.\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
        );
      }

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

      if (!user.render_token) {
        return textResponse(
          "No Render API key configured. Add it at spendexai.com/connect.",
          { isError: true }
        );
      }

      // If there's a cost AND the user's auto-approve threshold is non-zero AND
      // the cost exceeds the threshold → refuse and tell the agent to ask the user.
      if (
        RENDER_DEPLOY_COST_USD > 0 &&
        user.max_auto_charge_usd > 0 &&
        RENDER_DEPLOY_COST_USD > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This action would charge $${RENDER_DEPLOY_COST_USD.toFixed(2)} but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      const deployDescription = `Render deploy: ${input.service_id}`;
      const idempotencyKey = `${user.id}-render-${input.service_id}-${Date.now()}`;

      let transactionId: string | null = null;

      try {
        const charge = await routePayment({
          userId: user.id,
          paymentMethod: user.payment_method,
          providerCustomerId: user.payment_provider_customer_id,
          amountUsd: RENDER_DEPLOY_COST_USD,
          description: deployDescription,
          idempotencyKey,
          metadata: {
            service: "render",
            service_id: input.service_id,
          },
        });

        transactionId = charge.transactionId;
      } catch (err) {
        const message = errorMessage(err, "Unknown payment error");
        await logTransaction({
          userId: user.id,
          service: "render",
          status: "payment_failed",
          amountUsd: RENDER_DEPLOY_COST_USD,
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
        const deployment = await triggerRenderDeploy({
          serviceId: input.service_id,
          renderToken: user.render_token,
        });

        const polled = await pollRenderDeploy(
          input.service_id,
          deployment.deployId,
          user.render_token
        );

        deploymentUrl = polled.url;
      } catch (deployErr) {
        const deployMessage = deployErr instanceof ProviderError
          ? deployErr.message
          : errorMessage(deployErr, "Unknown deploy error");
        let auditLogError: Error | null = null;

        try {
          await logTransaction({
            userId: user.id,
            service: "render",
            status: "deploy_failed_after_payment",
            amountUsd: RENDER_DEPLOY_COST_USD,
            transactionId: transactionId ?? undefined,
            description: deployDescription,
            error: deployMessage,
          });
        } catch (logErr) {
          auditLogError = logErr instanceof Error ? logErr : new Error(String(logErr));
        }

        const txn = transactionId ?? "unknown";
        const chargeNote =
          RENDER_DEPLOY_COST_USD > 0
            ? ` Your account was charged $${RENDER_DEPLOY_COST_USD.toFixed(2)} (transaction: ${txn}). Contact support at spendexai.com/support to request a refund.`
            : " (No charge was made for this deploy.)";

        const auditNote = auditLogError
          ? ` WARNING: The audit log could not be written (${auditLogError.message}). This charge is not recorded — contact support immediately with transaction ID: ${txn}.`
          : "";

        return textResponse(
          `Render deploy failed: ${deployMessage}.${chargeNote}${auditNote}`,
          { isError: true }
        );
      }

      await logTransaction({
        userId: user.id,
        service: "render",
        status: "success",
        amountUsd: RENDER_DEPLOY_COST_USD,
        transactionId: transactionId ?? undefined,
        description: deployDescription,
      });

      return textResponse(`Deployed successfully. Dashboard: ${deploymentUrl}`);
    }
  );
}
