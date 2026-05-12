/**
 * subscribe_service — track a recurring charge for a user.
 *
 * `pay_for_service` is one-shot. This tool handles the other half of the
 * payment graph: things that bill on a cadence (Vercel Pro $20/mo, Netflix,
 * Spotify, GitHub Pro). It does NOT charge the user up-front — it persists a
 * subscriptions row and returns the next charge date. A separate renewal
 * cron (V3, out of scope here) walks active rows where next_charge_at<=now()
 * and triggers the actual charge through the existing pay-for-service path,
 * so rules are re-evaluated AT EACH CYCLE rather than once at signup.
 *
 * The legacy `subscribe_to_service` tool (one-shot charge + simulated
 * "subscription") remains in src/tools/subscribe-service.ts under the old
 * name for backwards compatibility — see `registerSubscribeServiceTool` at
 * the bottom of this file. New integrations should call `subscribe_service`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import {
  computeNextChargeAt,
  createSubscription,
  getMonthlySpendUsd,
  getRulesForUser,
  logTransaction,
  type SpendexRule,
  type SubscriptionInterval,
} from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

const IntervalEnum = z
  .enum(["monthly", "yearly", "weekly"])
  .describe(
    "Renewal cadence. " +
    '"monthly" for typical SaaS plans (Vercel Pro, Netflix, Spotify). ' +
    '"yearly" for annual subscriptions (JetBrains, GitHub Pro annual). ' +
    '"weekly" for short-cycle recurring credits.'
  );

const SubscribeServiceInput = z.object({
  service: z
    .string()
    .min(1)
    .describe(
      "Merchant or service name (e.g. 'vercel', 'netflix', 'spotify'). " +
      "Used to evaluate the user's per-service spending rules at every cycle."
    ),
  amount_usd: z
    .number()
    .positive()
    .describe("Recurring charge amount in USD. Must be greater than zero."),
  interval: IntervalEnum,
  description: z
    .string()
    .min(1)
    .describe(
      "Short human-readable label for the subscription, written for the " +
      "END USER (e.g. 'Vercel Pro plan for my-app'). Appears on the user's " +
      "dashboard and on each renewal receipt — keep it specific and concrete."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

function declineMessage(reason: string, suggestion: string): string {
  return `SUBSCRIPTION DECLINED: ${reason}. Your agent should: ${suggestion}.`;
}

/**
 * Rules check tailored to a recurring charge.
 *
 * We evaluate the *first* renewal exactly the way `pay_for_service` would —
 * blocked/allowed lists, per-tx caps (including per-service per-tx cap), and
 * a "would adding this charge to month-to-date push us over the monthly cap"
 * projection. We deliberately do NOT also project N-month spend — the cron
 * re-evaluates each renewal so a user who later tightens a rule will simply
 * have the next renewal decline at that point.
 */
async function evaluateSubscriptionRules(params: {
  userId: string;
  service: string;
  amountUsd: number;
  userMaxAutoCharge: number;
  rules: SpendexRule[];
}): Promise<string | null> {
  const { userId, service, amountUsd, userMaxAutoCharge, rules } = params;
  const normalizedService = service.toLowerCase();

  for (const rule of rules) {
    if (rule.blocked_services && rule.blocked_services.length > 0) {
      const blocked = rule.blocked_services.map((s) => s.toLowerCase());
      if (blocked.includes(normalizedService)) {
        return declineMessage(
          `the service "${service}" is on the user's blocked-services list`,
          "ask the user to remove it from spendexai.com/dashboard/rules or pick another provider"
        );
      }
    }
    if (rule.allowed_services && rule.allowed_services.length > 0) {
      const allowed = rule.allowed_services.map((s) => s.toLowerCase());
      if (!allowed.includes(normalizedService)) {
        return declineMessage(
          `the service "${service}" is not on the user's allowed-services list`,
          "ask the user to add it at spendexai.com/dashboard/rules or use one of the permitted services"
        );
      }
    }
  }

  // Per-service per-tx cap is the most specific — surface it first.
  for (const rule of rules) {
    if (rule.per_service_per_tx_cap_usd === null) continue;
    if (amountUsd > rule.per_service_per_tx_cap_usd) {
      return declineMessage(
        `per-transaction cap for ${service} exceeded ` +
        `($${amountUsd.toFixed(2)} attempted, $${rule.per_service_per_tx_cap_usd.toFixed(2)} cap)`,
        `ask the user to raise the ${service} per-transaction cap at spendexai.com/dashboard/rules ` +
        "or pick a cheaper plan"
      );
    }
  }

  // Global per-tx cap — combine user.max_auto_charge_usd with the tightest
  // rule cap. max_auto_charge_usd === 0 means "no auto-approval threshold".
  let effectiveTxCap: number | null = null;
  if (userMaxAutoCharge > 0) effectiveTxCap = userMaxAutoCharge;
  for (const rule of rules) {
    if (rule.max_per_transaction_usd === null) continue;
    if (effectiveTxCap === null || rule.max_per_transaction_usd < effectiveTxCap) {
      effectiveTxCap = rule.max_per_transaction_usd;
    }
  }
  if (effectiveTxCap !== null && amountUsd > effectiveTxCap) {
    return declineMessage(
      `$${amountUsd.toFixed(2)} exceeds the per-transaction cap of ` +
      `$${effectiveTxCap.toFixed(2)} for ${service}`,
      "ask the user to confirm this recurring charge or raise the cap at " +
      "spendexai.com/dashboard/rules"
    );
  }

  // Monthly cap projection for the first renewal — checks both the
  // per-service monthly cap and the global monthly budget. Same spend cache
  // pattern as pay_for_service so we hit the DB once per filter scope.
  const spendCache = new Map<string, number>();
  async function spendFor(filter: string | null): Promise<number> {
    const key = filter ?? "__all__";
    const cached = spendCache.get(key);
    if (cached !== undefined) return cached;
    const value = await getMonthlySpendUsd(userId, filter ?? undefined);
    spendCache.set(key, value);
    return value;
  }

  const perServiceMonthlyRule = rules.find(
    (r) => r.per_service_monthly_cap_usd !== null
  );
  if (perServiceMonthlyRule) {
    const cap = perServiceMonthlyRule.per_service_monthly_cap_usd as number;
    const spent = await spendFor(service);
    if (spent + amountUsd > cap) {
      return declineMessage(
        `the first renewal would push ${service} spend this month from ` +
        `$${spent.toFixed(2)} to $${(spent + amountUsd).toFixed(2)}, over the ` +
        `$${cap.toFixed(2)} cap`,
        `ask the user to raise the ${service} monthly cap at spendexai.com/dashboard/rules ` +
        "or pick a cheaper plan"
      );
    }
  }

  const monthlyRules = rules.filter((r) => r.monthly_budget_usd !== null);
  for (const rule of monthlyRules) {
    const budget = rule.monthly_budget_usd as number;
    const spent = await spendFor(rule.service_filter);
    if (spent + amountUsd > budget) {
      const scope = rule.service_filter ?? "all services";
      return declineMessage(
        `the first renewal would push this month's ${scope} spend to ` +
        `$${(spent + amountUsd).toFixed(2)}, over the $${budget.toFixed(2)} monthly budget ` +
        `(already spent: $${spent.toFixed(2)})`,
        "ask the user to raise the budget at spendexai.com/dashboard/rules " +
        "or pick a cheaper plan"
      );
    }
  }

  return null;
}

function formatIntervalLabel(interval: SubscriptionInterval): string {
  switch (interval) {
    case "weekly":
      return "week";
    case "monthly":
      return "month";
    case "yearly":
      return "year";
  }
}

// ---------------------------------------------------------------------------
// subscribe_service — primary tool
// ---------------------------------------------------------------------------

export function registerSubscribeService(server: McpServer): void {
  server.tool(
    "subscribe_service",
    "Track a recurring charge (Vercel Pro $20/mo, Netflix, Spotify, GitHub " +
    "Pro, …) on behalf of the user. Persists a subscription that re-evaluates " +
    "the user's spending rules at every cycle — no charge is made until the " +
    "first renewal date. Enforces the user's spending rules server-side " +
    "(per-tx caps, monthly budgets, blocked/allowed lists) before creating " +
    "the subscription. Use AFTER `signup_to_service` if a new account is " +
    "needed. For ONE-SHOT charges use `pay_for_service`. To stop a " +
    "subscription call `cancel_subscription`.",
    SubscribeServiceInput.shape,
    async (input) => {
      if (DEV_MODE) {
        const intervalLabel = formatIntervalLabel(input.interval);
        return textResponse(
          `[DEV MODE] subscribe_service called.\n` +
          `Service: ${input.service}\n` +
          `Amount: $${input.amount_usd.toFixed(2)} / ${intervalLabel}\n` +
          `Description: ${input.description}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n` +
          `\n` +
          `SUBSCRIPTION CREATED (simulated) — first charge would happen one ` +
          `${intervalLabel} from now. Use cancel_subscription({subscription_id}) ` +
          `to stop anytime.\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
        );
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      // Rules: load + evaluate before any persistence. A subscription that
      // violates the user's rules must never reach the DB — if we wrote it
      // and the V3 cron then declined, the user would see a ghost
      // subscription that never charges and never resolves cleanly.
      let rules: SpendexRule[];
      try {
        rules = await getRulesForUser(user.id, input.service);
      } catch (rulesErr) {
        return textResponse(
          `Could not verify spending rules: ${errorMessage(rulesErr, "unknown error")}. ` +
          `No subscription was created.`,
          { isError: true }
        );
      }

      let refusal: string | null;
      try {
        refusal = await evaluateSubscriptionRules({
          userId: user.id,
          service: input.service,
          amountUsd: input.amount_usd,
          userMaxAutoCharge: user.max_auto_charge_usd,
          rules,
        });
      } catch (evalErr) {
        return textResponse(
          `Could not verify monthly spend: ${errorMessage(evalErr, "unknown error")}. ` +
          `No subscription was created.`,
          { isError: true }
        );
      }

      if (refusal !== null) {
        return textResponse(refusal);
      }

      // Compute the first renewal date from "now" so the cron picks it up
      // exactly one interval later. UTC arithmetic — see computeNextChargeAt.
      const now = new Date();
      const nextChargeAt = computeNextChargeAt(now, input.interval);

      let subscription;
      try {
        subscription = await createSubscription({
          userId: user.id,
          service: input.service,
          amountUsd: input.amount_usd,
          interval: input.interval,
          description: input.description,
          nextChargeAt,
          metadata: {
            source: "subscribe_service",
            description: input.description,
          },
        });
      } catch (createErr) {
        return textResponse(
          `Could not create subscription: ${errorMessage(createErr, "unknown error")}. ` +
          `No subscription was created and the user was not charged.`,
          { isError: true }
        );
      }

      // Audit log — the subscribe event itself is free, but we record it so
      // dispute resolution can correlate later renewal charges to the
      // original signup. amountUsd=0 so it does NOT count against monthly
      // spend totals (those tally success rows with amount > 0).
      await logTransaction({
        userId: user.id,
        service: input.service,
        status: "success",
        amountUsd: 0,
        description: `Created subscription: ${input.description} ($${input.amount_usd.toFixed(2)} / ${formatIntervalLabel(input.interval)})`,
        transactionType: "subscription_create",
        agentId: subscription.id,
      });

      return textResponse(
        `SUBSCRIPTION CREATED — first charge will happen at ` +
        `${subscription.next_charge_at}.\n` +
        `\n` +
        `Service: ${input.service}\n` +
        `Amount: $${input.amount_usd.toFixed(2)} / ${formatIntervalLabel(input.interval)}\n` +
        `Subscription ID: ${subscription.id}\n` +
        `\n` +
        `Spending rules will be re-checked at every renewal. ` +
        `Use cancel_subscription({subscription_id: "${subscription.id}"}) to stop anytime, ` +
        `or list_subscriptions to see all active recurring charges.`
      );
    }
  );
}

// ---------------------------------------------------------------------------
// LEGACY: `subscribe_to_service` — one-shot charge kept for backwards compat.
//
// Kept verbatim from the pre-V2 surface so older agents that hard-coded the
// name still work. Marked [Deprecated] in the description and tagged with the
// "legacy" rules-pattern (one-shot routePayment + log) rather than the new
// recurring-subscriptions table.
// ---------------------------------------------------------------------------

import { config } from "../config.js";
import { getUserByMcpToken } from "../lib/db.js";
import { acquireIdempotencyKey, releaseIdempotencyKey } from "../lib/idempotency.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const LegacySubscribeServiceInput = z.object({
  service_name: z.string().min(1).describe("Name of the service to subscribe to (e.g. 'vercel', 'modal', 'cursor')"),
  plan_name: z.string().min(1).describe("Plan to subscribe to (e.g. 'pro', 'team')"),
  amount_usd: z.number().positive().describe("Monthly cost of the plan in USD"),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
});

export function registerSubscribeServiceTool(server: McpServer): void {
  server.tool(
    "subscribe_to_service",
    "[Deprecated — use subscribe_service instead] Legacy one-shot subscribe " +
    "tool. Charges the user once and returns; does NOT track recurring " +
    "renewals. New integrations should call `subscribe_service` which " +
    "persists a recurring schedule and re-evaluates rules at every cycle.",
    LegacySubscribeServiceInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] subscribe_to_service called.\n` +
          `Service: ${input.service_name}\n` +
          `Plan: ${input.plan_name}\n` +
          `Amount: $${input.amount_usd.toFixed(2)}/month\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method $${input.amount_usd.toFixed(2)} and activate the ${input.plan_name} plan on ${input.service_name}.\n` +
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
          "Spendex Pay is temporarily paused for maintenance. Please try again later or subscribe manually.",
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

      if (
        user.max_auto_charge_usd > 0 &&
        input.amount_usd > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This subscription would charge $${input.amount_usd.toFixed(2)}/month but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      const stableKey = `${user.id}-subscribe-${input.service_name}-${input.plan_name}`;
      if (!acquireIdempotencyKey(stableKey)) {
        return textResponse(
          "A subscription request for this service plan is already in progress. Please wait for it to complete before retrying.",
          { isError: true }
        );
      }

      try {
        const subscribeDescription = `Subscribe to ${input.service_name} ${input.plan_name} plan ($${input.amount_usd.toFixed(2)}/month)`;
        const idempotencyKey = `${user.id}-subscribe-${input.service_name}-${input.plan_name}-${Date.now()}`;

        let transactionId: string | null = null;

        try {
          const charge = await routePayment({
            userId: user.id,
            paymentMethod: user.payment_method,
            providerCustomerId: user.payment_provider_customer_id,
            amountUsd: input.amount_usd,
            description: subscribeDescription,
            idempotencyKey,
            transactionType: "subscription",
            metadata: {
              service: input.service_name,
              plan: input.plan_name,
              transaction_type: "subscription",
            },
          });

          transactionId = charge.transactionId;
        } catch (err) {
          const message = errorMessage(err, "Unknown payment error");
          await logTransaction({
            userId: user.id,
            service: input.service_name,
            status: "payment_failed",
            amountUsd: input.amount_usd,
            description: subscribeDescription,
            transactionType: "subscription",
            error: message,
          });

          return textResponse(
            `Payment failed: ${message}. Your account was not charged. Check your payment method at spendexai.com/billing.`,
            { isError: true }
          );
        }

        await logTransaction({
          userId: user.id,
          service: input.service_name,
          status: "success",
          amountUsd: input.amount_usd,
          transactionId: transactionId ?? undefined,
          description: subscribeDescription,
          transactionType: "subscription",
        });

        const txn = transactionId ?? "unknown";
        return textResponse(
          `Subscribed to ${input.service_name} ${input.plan_name} plan. ` +
          `Charged $${input.amount_usd.toFixed(2)} (transaction: ${txn}). ` +
          `Manage your subscription at spendexai.com/dashboard.`
        );
      } finally {
        releaseIdempotencyKey(stableKey);
      }
    }
  );
}
