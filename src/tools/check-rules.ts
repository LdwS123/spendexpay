import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import {
  getMonthlySpendUsd,
  getRulesForUser,
  getUserByMcpToken,
  type SpendexRule,
} from "../lib/db.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const CheckRulesInput = z.object({
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)."),
  service: z.string().optional().describe("Optional — service slug to simulate against (e.g. 'vercel', 'modal'). Must be provided together with `amount_usd` to trigger simulation; alone, it is ignored."),
  amount_usd: z.number().positive().optional().describe("Optional — prospective charge amount in USD. When provided together with `service`, returns an APPROVE/DECLINE simulation against the live rule engine; otherwise the tool just lists configured rules."),
});

const MCP_TOKEN_PATTERN = /^spx_[0-9a-f]{32}$/;

// Sentinel used when no service is supplied. Same trick as check-balance:
// users do not create rules scoped to this literal name, so the OR clause in
// getRulesForUser returns only the global (service_filter IS NULL) rules.
const INTROSPECT_SERVICE = "__introspect__";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

interface SimulationDecision {
  approved: boolean;
  reason: string;
}

/**
 * Run the same checks deploy-vercel.ts runs, but without touching the payment
 * provider. Mirrors `evaluateRules` in deploy-vercel.ts so the answer the
 * agent gets here matches what would actually happen at charge time.
 */
async function simulateDecision(
  userId: string,
  service: string,
  amountUsd: number,
  userMaxAutoCharge: number,
  rules: SpendexRule[]
): Promise<SimulationDecision> {
  // 1. User-level auto-approve cap (max_auto_charge_usd === 0 → always require
  //    user confirmation; > 0 means "auto-approve up to this amount").
  if (userMaxAutoCharge > 0 && amountUsd > userMaxAutoCharge) {
    return {
      approved: false,
      reason:
        `$${amountUsd.toFixed(2)} exceeds your auto-approve limit of ` +
        `$${userMaxAutoCharge.toFixed(2)} — the user must confirm this charge.`,
    };
  }

  // 2. Per-transaction caps from rules.
  for (const rule of rules) {
    if (rule.max_per_transaction_usd === null) continue;
    if (amountUsd > rule.max_per_transaction_usd) {
      const scope = rule.service_filter ?? "all services";
      return {
        approved: false,
        reason:
          `$${amountUsd.toFixed(2)} exceeds the per-transaction limit of ` +
          `$${rule.max_per_transaction_usd.toFixed(2)} for ${scope}.`,
      };
    }
  }

  // 3. Monthly budgets — only query spend when a budget rule exists. Caches
  //    per-scope spend lookups so a user with both a global and per-service
  //    budget triggers at most one extra query.
  const monthlyRules = rules.filter((r) => r.monthly_budget_usd !== null);
  if (monthlyRules.length > 0) {
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
      // monthly_budget_usd is non-null by the filter above.
      const budget = rule.monthly_budget_usd as number;
      const alreadySpent = await spendFor(rule.service_filter);
      if (alreadySpent + amountUsd > budget) {
        const scope = rule.service_filter ?? "all services";
        return {
          approved: false,
          reason:
            `$${amountUsd.toFixed(2)} would push this month's ${scope} spend ` +
            `to $${(alreadySpent + amountUsd).toFixed(2)}, over the ` +
            `$${budget.toFixed(2)} budget (already spent: $${alreadySpent.toFixed(2)}).`,
        };
      }
    }
  }

  return {
    approved: true,
    reason:
      `$${amountUsd.toFixed(2)} for ${service} is within all configured limits.`,
  };
}

function formatRulesList(
  rules: SpendexRule[],
  userMaxAutoCharge: number
): string {
  const lines: string[] = [];

  lines.push(
    `Auto-approve cap (user-level): ` +
      (userMaxAutoCharge > 0
        ? `$${userMaxAutoCharge.toFixed(2)} per transaction`
        : "0 — every charge requires user confirmation")
  );

  if (rules.length === 0) {
    lines.push("No additional spending rules configured.");
    return lines.join("\n");
  }

  lines.push(`Active rules (${rules.length}):`);
  for (const rule of rules) {
    const scope = rule.service_filter ?? "all services";
    const parts: string[] = [];
    if (rule.max_per_transaction_usd !== null) {
      parts.push(`max $${rule.max_per_transaction_usd.toFixed(2)}/tx`);
    }
    if (rule.monthly_budget_usd !== null) {
      parts.push(`max $${rule.monthly_budget_usd.toFixed(2)}/month`);
    }
    if (parts.length === 0) parts.push("no caps");
    lines.push(`  - [${scope}] ${parts.join(", ")}`);
  }

  lines.push(
    "Manage rules at spendexai.com/dashboard/rules."
  );
  return lines.join("\n");
}

export function registerCheckRulesTool(server: McpServer): void {
  server.tool(
    "check_spending_rules",
    "Inspect the user's active spending rules (per-tx caps, monthly " +
    "budgets, allow/block lists), or — when `service` and `amount_usd` are " +
    "both provided — simulate whether that exact charge would be APPROVED " +
    "or DECLINED without actually charging anything. Read-only. Call " +
    "BEFORE a costly or irreversible operation to avoid wasted work. For a " +
    "general budget overview without a specific charge in mind, prefer " +
    "`check_balance`.",
    CheckRulesInput.shape,
    async (input) => {
      if (DEV_MODE) {
        if (input.service && input.amount_usd !== undefined) {
          const decision =
            input.amount_usd > 100
              ? `DECLINED — $${input.amount_usd.toFixed(2)} exceeds the simulated $100 per-transaction cap.`
              : `APPROVED — $${input.amount_usd.toFixed(2)} for ${input.service} is within all simulated limits.`;
          return textResponse(
            `[DEV MODE] check_spending_rules simulation.\n` +
            `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
            `This charge would be ${decision}`
          );
        }
        return textResponse(
          `[DEV MODE] check_spending_rules called.\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `Auto-approve cap (user-level): $50.00 per transaction\n` +
          `Active rules (1):\n` +
          `  - [all services] max $100.00/tx, max $500.00/month\n` +
          `Manage rules at spendexai.com/dashboard/rules.`
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
          "Spendex Pay is temporarily paused for maintenance. Please try again later.",
          { isError: true }
        );
      }

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

      const simulating = input.service !== undefined && input.amount_usd !== undefined;
      const serviceForQuery = simulating
        ? (input.service as string)
        : INTROSPECT_SERVICE;

      let rules: SpendexRule[];
      try {
        rules = await getRulesForUser(user.id, serviceForQuery);
      } catch (err) {
        return textResponse(
          `Could not load spending rules: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }

      if (simulating) {
        const service = input.service as string;
        const amount = input.amount_usd as number;
        let decision: SimulationDecision;
        try {
          decision = await simulateDecision(
            user.id,
            service,
            amount,
            user.max_auto_charge_usd,
            rules
          );
        } catch (err) {
          return textResponse(
            `Could not simulate decision: ${errorMessage(err, "unknown error")}.`,
            { isError: true }
          );
        }

        if (decision.approved) {
          return textResponse(
            `This charge would be APPROVED. ${decision.reason}`
          );
        }
        return textResponse(
          `This charge would be DECLINED because ${decision.reason} ` +
          `Adjust limits at spendexai.com/dashboard/rules.`
        );
      }

      return textResponse(formatRulesList(rules, user.max_auto_charge_usd));
    }
  );
}
