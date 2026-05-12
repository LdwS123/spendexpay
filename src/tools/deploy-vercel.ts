import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import {
  getMonthlySpendUsd,
  getRulesForUser,
  getUserByMcpToken,
  logTransaction,
  type SpendexRule,
} from "../lib/db.js";
import { acquireIdempotencyKey, releaseIdempotencyKey } from "../lib/idempotency.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { triggerVercelDeploy, pollVercelDeployment } from "../lib/vercel.js";
import { ProviderError } from "../lib/provider-error.js";

const DeployVercelInput = z.object({
  project_name: z.string().min(1).describe("The Vercel project name (must match exactly as shown in your Vercel dashboard)"),
  team_slug: z.string().optional().describe("Your Vercel team slug (optional — only needed for team projects)"),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
});

// Vercel Pro plan includes deploys — cost is $0 per deploy.
// When Vercel charges overages (bandwidth, functions), update this value
// or fetch it dynamically from the user's Vercel billing API.
const VERCEL_DEPLOY_COST_USD = 0;

// Symbolic test charge — used only when VERCEL_DEPLOY_COST_USD === 0 AND
// SPENDEX_TEST_CHARGE=true is set in the environment. Lets us exercise the
// full Stripe PaymentIntent path end-to-end (charge → audit log → return)
// against test keys without ever charging real money for a no-cost deploy.
const SPENDEX_TEST_CHARGE_USD = 0.01;

// Format: "spx_" + 32 lowercase hex chars. Validated before any DB lookup so
// random strings cannot consume rate-limit budget or trigger DB queries.
const MCP_TOKEN_PATTERN = /^spx_[0-9a-f]{32}$/;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

/**
 * Resolve the USD amount to charge for this deploy.
 *
 * Returns the real `VERCEL_DEPLOY_COST_USD` unless it is $0 AND the operator
 * has flipped `SPENDEX_TEST_CHARGE=true`, in which case we substitute the
 * symbolic test amount so the Stripe path actually runs.
 */
function resolveChargeAmountUsd(): number {
  if (VERCEL_DEPLOY_COST_USD === 0 && config.testChargeEnabled) {
    return SPENDEX_TEST_CHARGE_USD;
  }
  return VERCEL_DEPLOY_COST_USD;
}

/**
 * Evaluate active spending rules against the prospective charge.
 *
 * Returns a human-readable refusal message if any rule would be violated,
 * otherwise returns null. Rules are evaluated in two passes:
 *   1. Per-transaction cap — local, cheap, no DB query.
 *   2. Monthly budget — requires summing audit_logs, only run when needed.
 */
async function evaluateRules(
  userId: string,
  service: string,
  amountUsd: number,
  rules: SpendexRule[]
): Promise<string | null> {
  // Per-transaction caps first — they require no extra DB work.
  for (const rule of rules) {
    if (rule.max_per_transaction_usd === null) continue;
    if (amountUsd > rule.max_per_transaction_usd) {
      const scope = rule.service_filter ?? "all services";
      return (
        `Spending rule blocks this charge: $${amountUsd.toFixed(2)} exceeds the ` +
        `per-transaction limit of $${rule.max_per_transaction_usd.toFixed(2)} for ${scope}. ` +
        `Adjust the rule at spendexai.com/dashboard/rules.`
      );
    }
  }

  // Monthly budgets — only fetch spend once per scope we care about.
  const monthlyRules = rules.filter((r) => r.monthly_budget_usd !== null);
  if (monthlyRules.length === 0) return null;

  // Cache spend lookups: a "global" lookup (no service filter) covers all
  // services; a "per-service" lookup is only needed for rules scoped to one.
  const spendCache = new Map<string, number>();
  async function spendFor(filter: string | null): Promise<number> {
    const key = filter ?? "__all__";
    const cached = spendCache.get(key);
    if (cached !== undefined) return cached;
    const value = await getMonthlySpendUsd(userId, filter ?? undefined);
    spendCache.set(key, value);
    return value;
  }

  for (const rule of monthlyRules) {
    // Non-null asserted: we filtered to monthly_budget_usd !== null above.
    const budget = rule.monthly_budget_usd as number;
    const alreadySpent = await spendFor(rule.service_filter);
    if (alreadySpent + amountUsd > budget) {
      const scope = rule.service_filter ?? "all services";
      return (
        `Spending rule blocks this charge: $${amountUsd.toFixed(2)} would push this month's ` +
        `${scope} spend to $${(alreadySpent + amountUsd).toFixed(2)}, over your $${budget.toFixed(2)} budget. ` +
        `Already spent this month: $${alreadySpent.toFixed(2)}. ` +
        `Raise the limit at spendexai.com/dashboard/rules.`
      );
    }
  }

  return null;
}

export function registerDeployVercelTool(server: McpServer) {
  server.tool(
    "deploy_to_vercel",
    "[Legacy fallback — prefer pay_for_service for new integrations] Deploy a Vercel project on behalf of the user. Handles payment automatically.",
    DeployVercelInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] deploy_to_vercel called.\n` +
          `Project: ${input.project_name}\n` +
          `Team: ${input.team_slug ?? "personal"}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method, trigger a Vercel deploy, and return the deployment URL.\n` +
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

      // Reject obviously malformed tokens before hitting the DB. A real
      // Spendex MCP token is "spx_" + 32 hex chars; anything else cannot
      // possibly match a stored hash, so we save a round-trip.
      if (!MCP_TOKEN_PATTERN.test(input.mcp_token)) {
        return textResponse(
          "Invalid MCP token format. A Spendex token looks like `spx_…` (32 hex chars). " +
            "Get yours at spendexai.com/dashboard/tokens.",
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

      // Pre-flight: make sure the user has the credentials we need before we
      // touch any payment provider. Failing early here keeps the audit log
      // clean of "charged then immediately failed" rows for trivially
      // recoverable misconfiguration.
      if (!user.payment_provider_customer_id) {
        return textResponse(
          "No payment method on file. Add a card or bank account at spendexai.com/dashboard/payments " +
            "before deploying.",
          { isError: true }
        );
      }

      if (!user.vercel_token) {
        return textResponse(
          "No Vercel API token on file. Generate one at vercel.com/account/tokens, then save it at " +
            "spendexai.com/dashboard/settings before deploying.",
          { isError: true }
        );
      }

      const chargeAmountUsd = resolveChargeAmountUsd();

      // If there's a cost AND the user's auto-approve threshold is non-zero AND
      // the cost exceeds the threshold → refuse and tell the agent to ask the user.
      if (
        chargeAmountUsd > 0 &&
        user.max_auto_charge_usd > 0 &&
        chargeAmountUsd > user.max_auto_charge_usd
      ) {
        return textResponse(
          `This action would charge $${chargeAmountUsd.toFixed(2)} but your auto-approve limit is ` +
            `$${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or ` +
            `increase their limit at spendexai.com/dashboard.`
        );
      }

      // Apply user-defined spending rules (per-transaction caps, monthly budgets).
      // Skip the DB roundtrips entirely when the charge is $0 — no rule can
      // be violated by a no-op transaction.
      if (chargeAmountUsd > 0) {
        try {
          const rules = await getRulesForUser(user.id, "vercel");
          const refusal = await evaluateRules(user.id, "vercel", chargeAmountUsd, rules);
          if (refusal) {
            return textResponse(refusal, { isError: true });
          }
        } catch (rulesErr) {
          return textResponse(
            `Could not verify spending rules: ${errorMessage(rulesErr, "unknown error")}. ` +
              `Your account was not charged.`,
            { isError: true }
          );
        }
      }

      // Guard against duplicate in-flight requests for the same user+project.
      // Uses stable parts only (no timestamp) so a retry from the agent while
      // the first request is still running is correctly rejected.
      const stableKey = `${user.id}-vercel-${input.project_name}`;
      if (!acquireIdempotencyKey(stableKey)) {
        return textResponse(
          "A deploy for this project is already in progress. Please wait for it to complete before retrying.",
          { isError: true }
        );
      }

      try {
        const deployDescription = `Vercel deploy: ${input.project_name}${input.team_slug ? ` (team: ${input.team_slug})` : ""}`;
        // Include a millisecond timestamp so each deploy attempt gets a unique
        // idempotency key. A day-granular key would cause Stripe to cache the result
        // of the first attempt and return it (including a "failed" status) for all
        // retries within the same calendar day, preventing recovery from failures.
        const idempotencyKey = `${user.id}-vercel-${input.project_name}-${Date.now()}`;

        let transactionId: string | null = null;

        try {
          const charge = await routePayment({
            userId: user.id,
            paymentMethod: user.payment_method,
            providerCustomerId: user.payment_provider_customer_id,
            amountUsd: chargeAmountUsd,
            description: deployDescription,
            idempotencyKey,
            metadata: {
              service: "vercel",
              project: input.project_name,
              team: input.team_slug ?? "personal",
            },
          });

          transactionId = charge.transactionId;
        } catch (err) {
          const message = errorMessage(err, "Unknown payment error");
          await logTransaction({
            userId: user.id,
            service: "vercel",
            status: "payment_failed",
            amountUsd: chargeAmountUsd,
            description: deployDescription,
            error: message,
          });

          return textResponse(
            `Payment failed: ${message}. Your account was not charged. Check your payment method at spendexai.com/dashboard/payments.`,
            { isError: true }
          );
        }

        let deploymentUrl: string;

        try {
          const deployment = await triggerVercelDeploy({
            projectName: input.project_name,
            teamSlug: input.team_slug,
            vercelToken: user.vercel_token,
          });

          const polled = await pollVercelDeployment(
            deployment.deploymentId,
            user.vercel_token
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
              service: "vercel",
              status: "deploy_failed_after_payment",
              amountUsd: chargeAmountUsd,
              transactionId: transactionId ?? undefined,
              description: deployDescription,
              error: deployMessage,
            });
          } catch (logErr) {
            auditLogError = logErr instanceof Error ? logErr : new Error(String(logErr));
          }

          // IMPORTANT: We intentionally do NOT say "payment voided" here.
          // The charge has already succeeded against the payment provider and
          // we have not issued a refund. If chargeAmountUsd is non-zero, the
          // support team must issue a manual refund using transactionId.
          const txn = transactionId ?? "unknown";
          const chargeNote =
            chargeAmountUsd > 0
              ? ` Your account was charged $${chargeAmountUsd.toFixed(2)} (transaction: ${txn}). Contact support at spendexai.com/support to request a refund.`
              : " (No charge was made for this deploy.)";

          const auditNote = auditLogError
            ? ` WARNING: The audit log could not be written (${auditLogError.message}). This charge is not recorded — contact support immediately with transaction ID: ${txn}.`
            : "";

          return textResponse(
            `Vercel deploy failed: ${deployMessage}.${chargeNote}${auditNote}`,
            { isError: true }
          );
        }

        await logTransaction({
          userId: user.id,
          service: "vercel",
          status: "success",
          amountUsd: chargeAmountUsd,
          transactionId: transactionId ?? undefined,
          description: deployDescription,
        });

        const chargedLine =
          chargeAmountUsd > 0
            ? `\nCharged: $${chargeAmountUsd.toFixed(2)}${transactionId ? ` (transaction: ${transactionId})` : ""}`
            : "";

        return textResponse(
          `Deployed successfully. Preview URL: ${deploymentUrl}${chargedLine}`
        );
      } finally {
        releaseIdempotencyKey(stableKey);
      }
    }
  );
}
