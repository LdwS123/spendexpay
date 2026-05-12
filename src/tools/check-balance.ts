import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import {
  getMonthlySpendUsd,
  getRulesForUser,
  type SpendexRule,
} from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

const CheckBalanceInput = z.object({
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
});

// Sentinel service name passed to getRulesForUser when we only care about
// global (service_filter IS NULL) rules. Users do not create rules scoped to a
// literal service called "__introspect__", so the OR clause returns only the
// global rows.
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

interface BalancePayload {
  monthly_spent_usd: number;
  monthly_budget_usd: number | null;
  max_per_transaction_usd: number;
  currency: "eur";
}

/**
 * Choose the tightest per-transaction cap that applies to "all services".
 *
 * We deliberately ignore per-service rules — this is an introspection endpoint
 * with no service context, so reporting a Modal-only cap as the user's global
 * cap would be misleading. The user-level `max_auto_charge_usd` is always the
 * fallback floor.
 */
function resolveMaxPerTxUsd(
  rules: SpendexRule[],
  userAutoCharge: number
): number {
  let cap: number | null = null;
  for (const rule of rules) {
    if (rule.service_filter !== null) continue;
    if (rule.max_per_transaction_usd === null) continue;
    if (cap === null || rule.max_per_transaction_usd < cap) {
      cap = rule.max_per_transaction_usd;
    }
  }

  // user.max_auto_charge_usd === 0 means "always require confirmation". When
  // there's no explicit rule, surface the user-level limit so the agent can
  // self-pace. When both exist, the smaller wins.
  if (cap === null) return userAutoCharge;
  if (userAutoCharge > 0 && userAutoCharge < cap) return userAutoCharge;
  return cap;
}

/**
 * Pick the active global monthly budget, if any. If multiple global budget
 * rules exist, the smallest wins — same conservative principle as per-tx caps.
 */
function resolveMonthlyBudgetUsd(rules: SpendexRule[]): number | null {
  let budget: number | null = null;
  for (const rule of rules) {
    if (rule.service_filter !== null) continue;
    if (rule.monthly_budget_usd === null) continue;
    if (budget === null || rule.monthly_budget_usd < budget) {
      budget = rule.monthly_budget_usd;
    }
  }
  return budget;
}

function formatBalanceText(payload: BalancePayload): string {
  const spent = payload.monthly_spent_usd.toFixed(2);
  const perTx = payload.max_per_transaction_usd.toFixed(2);

  if (payload.monthly_budget_usd === null) {
    return (
      `This month: $${spent} spent. No monthly budget configured. ` +
      `Per-transaction limit: $${perTx}.`
    );
  }

  const budget = payload.monthly_budget_usd;
  const pct = budget > 0
    ? Math.min(100, Math.round((payload.monthly_spent_usd / budget) * 100))
    : 0;
  return (
    `This month: $${spent} / $${budget.toFixed(2)} (${pct}% used). ` +
    `Per-transaction limit: $${perTx}.`
  );
}

export function registerCheckBalanceTool(server: McpServer): void {
  server.tool(
    "check_balance",
    "Report the user's month-to-date Spendex spend, configured monthly " +
    "budget, and per-transaction cap. Read-only — never moves money or " +
    "mutates state. Call BEFORE a large or batched charge so the agent can " +
    "self-throttle and avoid a surprise DECLINED from `pay_for_service`. " +
    "For a 'would this specific charge pass?' simulation, use " +
    "`check_spending_rules` with service + amount_usd instead.",
    CheckBalanceInput.shape,
    async (input) => {
      if (DEV_MODE) {
        const payload: BalancePayload = {
          monthly_spent_usd: 12.34,
          monthly_budget_usd: 100,
          max_per_transaction_usd: 50,
          currency: "eur",
        };
        return textResponse(
          `[DEV MODE] check_balance called.\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          formatBalanceText(payload)
        );
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      let rules: SpendexRule[];
      let monthlySpent: number;
      try {
        rules = await getRulesForUser(user.id, INTROSPECT_SERVICE);
        monthlySpent = await getMonthlySpendUsd(user.id);
      } catch (err) {
        return textResponse(
          `Could not read account state: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }

      const payload: BalancePayload = {
        monthly_spent_usd: monthlySpent,
        monthly_budget_usd: resolveMonthlyBudgetUsd(rules),
        max_per_transaction_usd: resolveMaxPerTxUsd(rules, user.max_auto_charge_usd),
        currency: "eur",
      };

      return textResponse(formatBalanceText(payload));
    }
  );
}
