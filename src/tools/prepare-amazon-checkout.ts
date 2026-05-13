/**
 * prepare_amazon_checkout — LEGACY alias for `prepare_checkout`.
 *
 * The original Amazon-only playbook tool has been generalized into the
 * universal `prepare_checkout` tool (see `src/tools/prepare-checkout.ts`),
 * which looks up merchant playbooks from `src/lib/merchant-playbooks.ts`.
 * This file remains as a backwards-compatibility shim so existing agents
 * that hard-coded `prepare_amazon_checkout` keep working without a code
 * change.
 *
 * The shim:
 *   - Accepts the original input schema (product_url, quantity, variant_options,
 *     use_amazon_account, mcp_token).
 *   - Translates `use_amazon_account` to the new `login_strategy` enum
 *     ("user_personal" → "user_existing").
 *   - Hard-codes `merchant: "amazon"`.
 *   - Delegates to `handlePrepareCheckout` — same authentication, same audit
 *     log, same security guarantees.
 *
 * New integrations should call `prepare_checkout` directly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handlePrepareCheckout } from "./prepare-checkout.js";

const LegacyAmazonAccountModeEnum = z
  .enum(["spendex_managed", "user_personal"])
  .describe(
    "[Legacy] Which Amazon account the agent will sign into. " +
    '"spendex_managed" (default) — use the Spendex-provisioned alias account. ' +
    '"user_personal" — the user is already signed in on this browser session. ' +
    "Prefer the new `login_strategy` field on `prepare_checkout`."
  );

const LegacyInput = z.object({
  product_url: z
    .string()
    .url()
    .describe("Canonical Amazon product URL — typically https://www.amazon.com/dp/<ASIN>."),
  quantity: z
    .number()
    .int()
    .positive()
    .max(99)
    .optional()
    .describe("Quantity to order (default 1)."),
  variant_options: z
    .record(z.string(), z.string())
    .optional()
    .describe('Map of variant axis → chosen value (e.g. {"color":"black"}).'),
  use_amazon_account: LegacyAmazonAccountModeEnum.optional(),
  // Optional in the legacy schema for compatibility — most callers omit it
  // because the legacy tool didn't ask for it. Defaults to 0, which means
  // the per-authorization cap warning never fires from this path. Callers
  // that want the cap check should switch to `prepare_checkout`.
  amount_usd: z
    .number()
    .nonnegative()
    .optional()
    .describe("Expected order total in USD. Optional in legacy mode (defaults to 0)."),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

type LegacyInputT = z.infer<typeof LegacyInput>;

export function registerPrepareAmazonCheckoutTool(server: McpServer): void {
  server.tool(
    "prepare_amazon_checkout",
    "[Legacy — use prepare_checkout] Generate a Computer-Use checkout playbook " +
    "for Amazon.com. Delegates to the universal `prepare_checkout` tool with " +
    'merchant="amazon". Preserved for backwards compatibility with agents that ' +
    "hard-coded the Amazon-only tool name.",
    LegacyInput.shape,
    async (input: LegacyInputT) => {
      const login_strategy =
        input.use_amazon_account === "user_personal"
          ? "user_existing"
          : "spendex_managed";
      return handlePrepareCheckout({
        merchant: "amazon",
        product_url: input.product_url,
        amount_usd: input.amount_usd ?? 0,
        quantity: input.quantity,
        variant_options: input.variant_options,
        login_strategy,
        mcp_token: input.mcp_token,
      });
    }
  );
}
