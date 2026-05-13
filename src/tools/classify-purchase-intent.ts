/**
 * classify_purchase_intent — preview the smart-rules classifier without
 * committing to a charge.
 *
 * Lets an agent ask "what category / urgency / risk score would Spendex
 * assign to this purchase?" before calling `pay_for_service`. Useful for:
 *
 *   - Self-checking: the agent can avoid surfacing a charge to the user
 *     when the risk score is obviously above their threshold.
 *   - UX: surface the category in the chat ("this looks like a gambling
 *     charge — confirm?") before the inline consent dialog appears.
 *   - Cost: re-calling on the same description is a cache hit, so an
 *     agent that pre-classifies pays nothing extra at pay time.
 *
 * Does NOT enforce any rules — purely informational. The actual rule
 * evaluation happens inside `pay_for_service`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import { classifyIntent } from "../lib/intent-classifier.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

const ClassifyInput = z.object({
  service: z
    .string()
    .min(1)
    .describe("Merchant or service name (e.g. 'vercel', 'amazon', 'draftkings')."),
  amount_usd: z
    .number()
    .positive()
    .describe("Charge amount in USD that you are considering."),
  description: z
    .string()
    .min(1)
    .describe(
      "Short human-readable reason for the charge — same text you would pass " +
      "to pay_for_service. The classifier uses this to pick the right category."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

export function registerClassifyPurchaseIntentTool(server: McpServer): void {
  server.tool(
    "classify_purchase_intent",
    "Preview how Spendex's smart-rules engine will classify a purchase " +
    "BEFORE you call pay_for_service. Returns the inferred category " +
    "(dev_tools, shopping, subscription, gambling, …), urgency (low / " +
    "medium / high), and a risk score from 0–100. Cached for 7 days, so " +
    "re-classifying the same description is free. Use this for self-checks " +
    "or to surface the classification to the user inline. This tool does " +
    "NOT enforce rules or move money — call pay_for_service for that.",
    ClassifyInput.shape,
    async (input) => {
      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;

      const result = await classifyIntent({
        service: input.service,
        description: input.description,
        amount_usd: input.amount_usd,
      });

      const json = JSON.stringify(
        {
          category: result.category,
          subcategory: result.subcategory,
          urgency: result.urgency,
          risk_score: result.risk_score,
          reasoning: result.reasoning,
          source: result.source,
          model: result.model,
        },
        null,
        2
      );

      const header = DEV_MODE
        ? `[DEV MODE] Simulated classification for ${input.service} ($${input.amount_usd.toFixed(2)}):`
        : `Classification for ${input.service} ($${input.amount_usd.toFixed(2)}) (source: ${result.source}):`;

      return textResponse(
        `${header}\n\n` +
        `Category:     ${result.category}${result.subcategory ? ` (${result.subcategory})` : ""}\n` +
        `Urgency:      ${result.urgency}\n` +
        `Risk score:   ${result.risk_score}/100\n` +
        `Reasoning:    ${result.reasoning}\n\n` +
        `JSON:\n${json}`
      );
    }
  );
}
