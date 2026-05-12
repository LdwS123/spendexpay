/**
 * MCP tool: check_anomalies
 *
 * Read-only introspection that runs three forensic checks against the
 * caller's recent activity and returns a formatted report plus a
 * `should_alert` flag. The same heuristics back the dashboard's amber
 * "unusual activity" banner — keeping the logic in src/lib/anomaly-detector
 * means the MCP surface and the dashboard never drift.
 *
 * The motivating scenario (V2 §5.8): a host agent that's been mis-wired to
 * auto-decline every consent prompt looks identical to a malicious agent
 * spam-clicking decline. Surfacing the pattern lets the user fix the
 * client without us having to debug their stack.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import { authenticateToolCall } from "../lib/tool-auth.js";
import {
  detectAmountOutlier,
  detectFastDeclines,
  detectVelocityAnomaly,
  type AmountOutlierResult,
  type FastDeclineStats,
} from "../lib/anomaly-detector.js";

const CheckAnomaliesInput = z.object({
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
  amount_usd: z
    .number()
    .positive()
    .optional()
    .describe(
      "Optional — prospective charge amount in USD. When supplied, the " +
      "amount-outlier check compares this against the user's running " +
      "14-day average and flags charges >= 10× that mean."
    ),
});

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(
  text: string,
  opts: { isError?: boolean } = {}
) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

const VELOCITY_THRESHOLD = 10;
const FAST_DECLINE_ALERT_FLOOR = 5;

interface AnomalyReport {
  fastDeclines: FastDeclineStats;
  velocity: boolean;
  amount: AmountOutlierResult | null;
  shouldAlert: boolean;
}

function formatReport(report: AnomalyReport): string {
  const lines: string[] = [];

  // Headline first: the user (and the agent reading the response) cares
  // most about "is anything wrong right now?" so we surface that flag at
  // the top before any of the per-check detail.
  if (report.shouldAlert) {
    lines.push("ALERT: unusual activity detected on this account.");
  } else {
    lines.push("No anomalies detected in the last 60 minutes.");
  }
  lines.push("");

  // Fast declines
  if (report.fastDeclines.count > 0) {
    lines.push(
      `Fast auto-declines: ${report.fastDeclines.count} in the last hour ` +
      `(avg ${report.fastDeclines.avgMs}ms between prompt and decline). ` +
      `A human cannot decide that fast — your agent may be wired to auto-decline.`
    );
  } else {
    lines.push("Fast auto-declines: none.");
  }

  // Velocity
  if (report.velocity) {
    lines.push(
      `Velocity: more than ${VELOCITY_THRESHOLD} transactions in the last hour. ` +
      `Review your agent's loop — it may be retrying too aggressively.`
    );
  } else {
    lines.push(`Velocity: under ${VELOCITY_THRESHOLD} tx/h (normal).`);
  }

  // Amount outlier (only when caller passed amount_usd)
  if (report.amount === null) {
    lines.push("Amount outlier: not checked (pass `amount_usd` to enable).");
  } else if (report.amount.isOutlier) {
    lines.push(
      `Amount outlier: this charge is ${report.amount.multiplier}× your ` +
      `14-day average of $${report.amount.avgAmount.toFixed(2)}. ` +
      `Double-check the amount before proceeding.`
    );
  } else if (report.amount.avgAmount === 0) {
    lines.push(
      "Amount outlier: no successful history yet — first-charge baseline."
    );
  } else {
    lines.push(
      `Amount outlier: within normal range ` +
      `(${report.amount.multiplier}× of $${report.amount.avgAmount.toFixed(2)} average).`
    );
  }

  return lines.join("\n");
}

export function registerCheckAnomaliesTool(server: McpServer): void {
  server.tool(
    "check_anomalies",
    "Inspect the user's recent Spendex activity for three classes of " +
    "anomaly: (1) sub-second 'fast auto-declines' that indicate a buggy " +
    "client auto-rejecting consent prompts, (2) velocity spikes (10+ " +
    "transactions in the last hour), and (3) when `amount_usd` is " +
    "supplied, charges >= 10× the user's 14-day average. Read-only — " +
    "never moves money. Use BEFORE a batched or unattended run so the " +
    "agent can pause and ask for human review if something looks off.",
    CheckAnomaliesInput.shape,
    async (input) => {
      if (DEV_MODE) {
        const report: AnomalyReport = {
          fastDeclines: { count: 0, avgMs: 0 },
          velocity: false,
          amount:
            input.amount_usd !== undefined
              ? { isOutlier: false, avgAmount: 20, multiplier: input.amount_usd / 20 }
              : null,
          shouldAlert: false,
        };
        return textResponse(
          `[DEV MODE] check_anomalies called.\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          formatReport(report)
        );
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      // Run the three checks in parallel — they're all read-only and share
      // no state. Serial execution would triple the wall time for no benefit.
      let fastDeclines: FastDeclineStats;
      let velocity: boolean;
      let amount: AmountOutlierResult | null;
      try {
        const [fd, vel, amt] = await Promise.all([
          detectFastDeclines(user.id),
          detectVelocityAnomaly(user.id),
          input.amount_usd !== undefined
            ? detectAmountOutlier(user.id, input.amount_usd)
            : Promise.resolve<AmountOutlierResult | null>(null),
        ]);
        fastDeclines = fd;
        velocity = vel;
        amount = amt;
      } catch (err) {
        return textResponse(
          `Could not run anomaly checks: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }

      // Alert when any check trips. Fast declines need at least 5 in the
      // window to count — one or two could be a user genuinely smashing the
      // decline button, but five in a row is mechanical.
      const shouldAlert =
        fastDeclines.count >= FAST_DECLINE_ALERT_FLOOR ||
        velocity ||
        (amount !== null && amount.isOutlier);

      const report: AnomalyReport = {
        fastDeclines,
        velocity,
        amount,
        shouldAlert,
      };
      return textResponse(formatReport(report));
    }
  );
}
