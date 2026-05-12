import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken, logTransaction } from "../lib/db.js";
import { acquireIdempotencyKey, releaseIdempotencyKey } from "../lib/idempotency.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import {
  createSupabaseProject,
  pollSupabaseProject,
} from "../lib/supabase-mgmt.js";
import { ProviderError } from "../lib/provider-error.js";

const ProvisionSupabaseProjectInput = z.object({
  project_name: z
    .string()
    .min(1)
    .max(64)
    .describe("Name for the new Supabase project"),
  organization_id: z
    .string()
    .min(1)
    .describe("Your Supabase organization ID (visible in Supabase dashboard URL)"),
  plan: z
    .enum(["free", "pro"])
    .default("free")
    .describe("Plan tier (free or pro)"),
  region: z
    .string()
    .default("us-east-1")
    .describe("Region slug (e.g. us-east-1, eu-west-1)"),
  db_password: z
    .string()
    .min(16)
    .describe(
      "Database password (min 16 chars). Spendex never stores this; it's sent to Supabase once."
    ),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
});

// Supabase Pro is $25/month per project. Free tier is, well, free.
// Source: https://supabase.com/pricing (verify periodically — if Supabase
// changes pricing, update these constants).
const SUPABASE_PLAN_COSTS_USD: Record<"free" | "pro", number> = {
  free: 0,
  pro: 25,
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

export function registerProvisionSupabaseProjectTool(server: McpServer): void {
  server.tool(
    "provision_supabase_project",
    "[Legacy fallback — prefer pay_for_service for new integrations] Provision a new Supabase project on behalf of the user. Handles payment automatically (Free or Pro plan). Use when an agent needs a Postgres database + auth + storage backend for a new project.",
    ProvisionSupabaseProjectInput.shape,
    async (input) => {
      if (DEV_MODE) {
        const cost = SUPABASE_PLAN_COSTS_USD[input.plan];
        return textResponse(
          `[DEV MODE] provision_supabase_project called.\n` +
          `Project: ${input.project_name}\n` +
          `Organization: ${input.organization_id}\n` +
          `Plan: ${input.plan} ($${cost.toFixed(2)}/month)\n` +
          `Region: ${input.region}\n` +
          `DB Password: [REDACTED, ${input.db_password.length} chars]\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method $${cost.toFixed(2)}/month (skipped on free), provision a Supabase project in your organization, and return the dashboard URL once it is ACTIVE_HEALTHY.\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
        );
      }

      // Rate limit runs before auth — prevents timing-based token probing
      // and protects the DB from runaway agents.
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
          "Spendex Pay is temporarily paused for maintenance. Please try again later or provision manually.",
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

      // db_password flows through this function but is NEVER logged, hashed, or
      // stored. Spendex's `users` table does not have a column for it. The user
      // provides it per-call; we forward to Supabase; we drop it.
      if (!user.supabase_user_token) {
        return textResponse(
          "Your Supabase personal access token is not configured. Generate one at supabase.com/dashboard/account/tokens and add it to your Spendex dashboard.",
          { isError: true }
        );
      }

      const costUsd = SUPABASE_PLAN_COSTS_USD[input.plan];

      // Refuse if the recurring cost exceeds the user's auto-approve threshold.
      // Never prompt the user inline — the agent must surface this to them instead.
      if (
        costUsd > 0 &&
        user.max_auto_charge_usd > 0 &&
        costUsd > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This action would charge $${costUsd.toFixed(2)}/month but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      // Guard against duplicate in-flight requests for the same user+project name.
      // Stable parts only (no timestamp) so a retry from the agent while the
      // first request is still running is correctly rejected.
      const stableKey = `${user.id}-supabase-project-${input.project_name}`;
      if (!acquireIdempotencyKey(stableKey)) {
        return textResponse(
          "A provisioning request for this project is already in progress. Please wait for it to complete before retrying.",
          { isError: true }
        );
      }

      try {
        const provisionDescription =
          `Provision Supabase project: ${input.project_name} ` +
          `(plan: ${input.plan}, region: ${input.region}` +
          `${costUsd > 0 ? `, $${costUsd.toFixed(2)}/month` : ""})`;

        // Millisecond timestamp ensures each attempt gets a fresh idempotency key,
        // so Stripe re-runs the charge rather than returning a cached failure.
        const idempotencyKey = `${user.id}-supabase-project-${input.project_name}-${Date.now()}`;

        let transactionId: string | null = null;

        if (costUsd > 0) {
          try {
            const charge = await routePayment({
              userId: user.id,
              paymentMethod: user.payment_method,
              providerCustomerId: user.payment_provider_customer_id,
              amountUsd: costUsd,
              description: provisionDescription,
              idempotencyKey,
              transactionType: "subscription",
              metadata: {
                service: "supabase",
                project: input.project_name,
                plan: input.plan,
                region: input.region,
                organization_id: input.organization_id,
                transaction_type: "subscription",
              },
            });

            transactionId = charge.transactionId;
          } catch (err) {
            const message = errorMessage(err, "Unknown payment error");
            await logTransaction({
              userId: user.id,
              service: "supabase",
              status: "payment_failed",
              amountUsd: costUsd,
              description: provisionDescription,
              transactionType: "subscription",
              error: message,
            });

            return textResponse(
              `Payment failed: ${message}. Your account was not charged. Check your payment method at spendexai.com/billing.`,
              { isError: true }
            );
          }
        }
        // For free plan (costUsd === 0): no routePayment call. We still log a
        // transaction below on success/failure with amountUsd=0 so there is
        // an audit trail of every provisioning attempt.

        let dashboardUrl: string;
        let projectRef: string;

        try {
          const created = await createSupabaseProject({
            name: input.project_name,
            organizationId: input.organization_id,
            plan: input.plan,
            region: input.region,
            // Forwarded to Supabase, then dropped. Never logged.
            dbPassword: input.db_password,
            supabaseAccessToken: user.supabase_user_token,
          });

          const polled = await pollSupabaseProject(
            created.projectRef,
            user.supabase_user_token
          );

          projectRef = polled.projectRef;
          dashboardUrl = polled.dashboardUrl;
        } catch (provisionErr) {
          // logTransaction throws when status="deploy_failed_after_payment"
          // and the DB write fails — that error message already includes the
          // transaction ID and instructs the user to contact support. We must
          // NOT swallow it here.
          const provisionMessage =
            provisionErr instanceof ProviderError
              ? provisionErr.message
              : errorMessage(provisionErr, "Unknown provisioning error");
          let auditLogError: Error | null = null;

          try {
            await logTransaction({
              userId: user.id,
              service: "supabase",
              status: "deploy_failed_after_payment",
              amountUsd: costUsd,
              transactionId: transactionId ?? undefined,
              description: provisionDescription,
              transactionType: costUsd > 0 ? "subscription" : undefined,
              error: provisionMessage,
            });
          } catch (logErr) {
            auditLogError =
              logErr instanceof Error ? logErr : new Error(String(logErr));
          }

          // IMPORTANT: we intentionally do NOT say "payment voided" here.
          // If costUsd > 0 the charge has already succeeded against the payment
          // provider and we have not issued a refund. Support must issue a
          // manual refund using transactionId.
          const txn = transactionId ?? "unknown";
          const chargeNote =
            costUsd > 0
              ? ` Your account was charged $${costUsd.toFixed(2)} (transaction: ${txn}). Contact support at spendexai.com/support to request a refund.`
              : " (No charge was made for this provisioning attempt — free plan.)";

          const auditNote = auditLogError
            ? ` WARNING: The audit log could not be written (${auditLogError.message}). This charge is not recorded — contact support immediately with transaction ID: ${txn}.`
            : "";

          return textResponse(
            `Supabase project provisioning failed: ${provisionMessage}.${chargeNote}${auditNote}`,
            { isError: true }
          );
        }

        await logTransaction({
          userId: user.id,
          service: "supabase",
          status: "success",
          amountUsd: costUsd,
          transactionId: transactionId ?? undefined,
          description: provisionDescription,
          transactionType: costUsd > 0 ? "subscription" : undefined,
        });

        const txn = transactionId ?? "n/a";
        const costLine =
          costUsd > 0
            ? `Charged $${costUsd.toFixed(2)}/month (transaction: ${txn}).`
            : `No charge (free plan).`;

        return textResponse(
          `Supabase project provisioned successfully.\n` +
          `Name: ${input.project_name}\n` +
          `Project ref: ${projectRef}\n` +
          `Plan: ${input.plan}\n` +
          `Region: ${input.region}\n` +
          `${costLine}\n` +
          `Dashboard: ${dashboardUrl}`
        );
      } finally {
        releaseIdempotencyKey(stableKey);
      }
    }
  );
}
