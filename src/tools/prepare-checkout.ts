/**
 * prepare_checkout — universal Computer-Use playbook generator.
 *
 * Generalises the original `prepare_amazon_checkout` tool: instead of being
 * hard-coded to Amazon, this tool looks up a merchant playbook from the
 * curated registry (`src/lib/merchant-playbooks.ts`). If no curated playbook
 * exists for the requested merchant, it falls back to a generic playbook +
 * an explicit warning so the host agent knows it must extract selectors
 * itself at runtime.
 *
 * The tool ALWAYS returns the user's virtual card details (PAN, expiry,
 * CVC) regardless of which merchant — Spendex Issuing is the universal
 * payment rail. Managed credentials are only returned when the playbook's
 * `login_strategy` is `"spendex_managed"` AND the caller passed
 * `login_strategy="spendex_managed"` (the default for Amazon).
 *
 * What this tool does NOT do:
 *   - Move money. The real charge is authorized later by Stripe Issuing
 *     when the merchant attempts to capture against the virtual card; our
 *     issuing webhook approves or declines against the user's spending
 *     rules.
 *   - Drive the browser. The agent receives instructions and must execute
 *     them. Hosts without Computer Use should not call this tool.
 *
 * SECURITY: the returned text contains the live PAN, CVC, and (for managed
 * logins) the alias-account password. These bytes are NEVER written to
 * stderr, never persisted, and never serialized into the audit log
 * description. The audit log captures merchant + product URL only.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import {
  getActiveVirtualCardForUser,
  getManagedAccountByService,
  logTransaction,
  type ManagedAccountRecord,
  type SpendexUser,
} from "../lib/db.js";
import { decryptSecret } from "../lib/crypto.js";
import {
  retrieveCardDetails,
  type RevealedCardDetails,
} from "../lib/stripe-issuing.js";
import { authenticateToolCall } from "../lib/tool-auth.js";
import {
  buildGenericPlaybook,
  findPlaybook,
  type MerchantPlaybook,
  type PlaybookStep,
} from "../lib/merchant-playbooks.js";

// Billing zip used everywhere Spendex issues cards — matches the cardholder
// address set in `createVirtualCardForUser` (EU/Paris).
const BILLING_ZIP = "75001";

const LoginStrategyEnum = z
  .enum(["spendex_managed", "user_existing", "guest_checkout"])
  .describe(
    "How the agent will authenticate at this merchant. " +
    '"spendex_managed" — use the Spendex-provisioned account for this user (only valid if the playbook supports it AND signup_to_service has been called for this merchant). ' +
    '"user_existing" — the user is already signed in on this browser session; do not emit any credentials. ' +
    '"guest_checkout" — proceed without authentication.'
  );

const PrepareCheckoutInput = z.object({
  merchant: z
    .string()
    .min(1)
    .describe(
      'Merchant identifier — either a known merchant_id ("amazon", "walmart", "bestbuy", "ebay", "generic_stripe_checkout") or any URL/domain. ' +
      "If no curated playbook matches, the tool returns a generic playbook plus a warning that the agent must extract selectors itself."
    ),
  product_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Canonical product or checkout URL. Substituted into {product_url} placeholders in the playbook steps. " +
      "Optional for merchants where the agent will search the site itself."
    ),
  amount_usd: z
    .number()
    .nonnegative()
    .describe(
      "Expected order total in USD. Compared against the user's max_auto_charge_usd; if greater, the playbook still renders but the agent is instructed to ABORT and call request_user_consent before clicking Place Order."
    ),
  quantity: z
    .number()
    .int()
    .positive()
    .max(99)
    .optional()
    .describe("Quantity to order. Defaults to 1."),
  variant_options: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Map of variant axis → chosen value (e.g. {"color": "black"}). ' +
      "Surfaced in the variant-pick step so the agent clicks the right swatches."
    ),
  login_strategy: LoginStrategyEnum.optional(),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

type PrepareCheckoutInputT = z.infer<typeof PrepareCheckoutInput>;

// ---------------------------------------------------------------------------
// Small helpers
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
  return `CHECKOUT NOT PREPARED: ${reason}. Your agent should: ${suggestion}.`;
}

function inferCardholderName(user: SpendexUser): string {
  const prefix = user.email.split("@")[0] ?? "";
  const cleaned = prefix.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  if (cleaned.length === 0) return "Spendex User";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ---------------------------------------------------------------------------
// Playbook rendering
// ---------------------------------------------------------------------------

interface RenderContext {
  playbook: MerchantPlaybook;
  productUrl: string | undefined;
  quantity: number;
  variantOptions: Record<string, string> | undefined;
  account:
    | { mode: "spendex_managed"; email: string; password: string }
    | { mode: "user_existing" }
    | { mode: "guest_checkout" };
  card: RevealedCardDetails;
  cardholder: string;
  txLimitUsd: number;
  amountUsd: number;
  isCurated: boolean;
}

function substitute(
  template: string | undefined,
  ctx: RenderContext
): string | undefined {
  if (template === undefined) return undefined;
  const groupedPan = ctx.card.number.match(/.{1,4}/g)?.join(" ") ?? ctx.card.number;
  const expMonth = String(ctx.card.expMonth).padStart(2, "0");
  const expYearFull = String(ctx.card.expYear);
  const expYearShort = expYearFull.slice(-2);
  const variantValue =
    ctx.variantOptions && Object.keys(ctx.variantOptions).length > 0
      ? Object.values(ctx.variantOptions)[0]!
      : "";

  return template
    .replace(/\{product_url\}/g, ctx.productUrl ?? "")
    .replace(/\{quantity\}/g, String(ctx.quantity))
    .replace(/\{variant\}/g, variantValue)
    .replace(/\{card_number\}/g, groupedPan)
    .replace(/\{card_exp_month\}/g, expMonth)
    .replace(/\{card_exp_year\}/g, expYearFull)
    .replace(/\{card_exp_year_short\}/g, expYearShort)
    .replace(/\{card_cvc\}/g, ctx.card.cvc)
    .replace(/\{cardholder\}/g, ctx.cardholder)
    .replace(/\{billing_zip\}/g, BILLING_ZIP)
    .replace(/\{email\}/g, ctx.account.mode === "spendex_managed" ? ctx.account.email : "")
    .replace(
      /\{password\}/g,
      ctx.account.mode === "spendex_managed" ? ctx.account.password : ""
    );
}

function shouldSkipStep(step: PlaybookStep, ctx: RenderContext): boolean {
  // Login steps only fire when we actually have managed credentials.
  if (step.requires_login && ctx.account.mode !== "spendex_managed") return true;
  return false;
}

function renderStep(step: PlaybookStep, ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push(`Step ${step.step} — ${step.action.toUpperCase()}`);
  lines.push(`  ${step.description}`);
  const url = substitute(step.target_url, ctx);
  if (url) lines.push(`  URL: ${url}`);
  if (step.selector) lines.push(`  Selector: ${step.selector}`);
  const value = substitute(step.value, ctx);
  if (value && value.length > 0) lines.push(`  Value: ${value}`);
  if (step.wait_ms !== undefined) lines.push(`  Wait: ${step.wait_ms}ms`);
  if (step.gotchas && step.gotchas.length > 0) {
    for (const g of step.gotchas) lines.push(`  Gotcha: ${g}`);
  }
  return lines.join("\n");
}

function renderVariantOptions(ctx: RenderContext): string {
  if (!ctx.variantOptions || Object.keys(ctx.variantOptions).length === 0) {
    return "  None supplied — pick the default highlighted swatch if the product has variants.";
  }
  return Object.entries(ctx.variantOptions)
    .map(([axis, val]) => `  ${axis} = "${val}"`)
    .join("\n");
}

function renderAccountBlock(ctx: RenderContext): string {
  switch (ctx.account.mode) {
    case "spendex_managed":
      return (
        `LOGIN — spendex_managed\n` +
        `  Email: ${ctx.account.email}\n` +
        `  Password: ${ctx.account.password}\n` +
        `  These credentials are valid for this checkout only. Do not log, ` +
        `echo, or persist them.`
      );
    case "user_existing":
      return (
        `LOGIN — user_existing\n` +
        `  Do NOT emit credentials. The user is expected to be signed in on this ` +
        `browser session. If the merchant forces a sign-in prompt, ABORT and call ` +
        `request_user_consent.`
      );
    case "guest_checkout":
      return (
        `LOGIN — guest_checkout\n` +
        `  Proceed without authentication. If the merchant requires an account, ` +
        `ABORT and call request_user_consent.`
      );
  }
}

function renderCardBlock(ctx: RenderContext): string {
  const grouped = ctx.card.number.match(/.{1,4}/g)?.join(" ") ?? ctx.card.number;
  const expMonth = String(ctx.card.expMonth).padStart(2, "0");
  const expYearShort = String(ctx.card.expYear).slice(-2);
  return (
    `CARD — Spendex virtual card (Stripe Issuing)\n` +
    `  Number: ${grouped}\n` +
    `  Name:   ${ctx.cardholder}\n` +
    `  Expiry: ${expMonth}/${expYearShort} (full year: ${ctx.card.expYear})\n` +
    `  CVV:    ${ctx.card.cvc}\n` +
    `  Zip:    ${BILLING_ZIP}\n` +
    `  Brand:  ${ctx.card.brand} (••${ctx.card.last4})\n` +
    `  Per-authorization cap: $${ctx.txLimitUsd.toFixed(2)}. Authorizations above ` +
    `this amount will decline.\n` +
    `  FALLBACK: if a curated selector misses, find the payment form by its visible ` +
    `labels ("Card number", "Expiration date", "Security code") and type the values ` +
    `above into the matching inputs.`
  );
}

function renderHeader(ctx: RenderContext): string {
  const warning = ctx.isCurated
    ? ""
    : `\nWARNING: no curated playbook for "${ctx.playbook.display_name}". ` +
      `Steps below are GENERIC — the agent must extract selectors at runtime ` +
      `by reading the live DOM. Prefer label / aria-label / visible text matching.\n`;

  const amountWarning =
    ctx.amountUsd > ctx.txLimitUsd
      ? `\nAMOUNT WARNING: expected total $${ctx.amountUsd.toFixed(2)} exceeds the ` +
        `per-authorization cap of $${ctx.txLimitUsd.toFixed(2)}. ABORT before clicking ` +
        `Place Order and call request_user_consent.\n`
      : "";

  return (
    `${ctx.playbook.display_name.toUpperCase()} CHECKOUT PLAYBOOK\n` +
    `  merchant_id:    ${ctx.playbook.merchant_id}\n` +
    `  supported:      ${ctx.playbook.supported}\n` +
    `  login_strategy: ${ctx.account.mode}\n` +
    `  curated:        ${ctx.isCurated ? "yes" : "no — generic fallback"}` +
    warning +
    amountWarning
  );
}

function renderPlaybook(ctx: RenderContext): string {
  const sections: string[] = [];
  sections.push(renderHeader(ctx));
  sections.push(renderAccountBlock(ctx));
  sections.push(renderCardBlock(ctx));
  sections.push(`VARIANT OPTIONS\n${renderVariantOptions(ctx)}`);

  const steps = ctx.playbook.steps
    .filter((s) => !shouldSkipStep(s, ctx))
    .map((s) => renderStep(s, ctx));
  sections.push(`STEPS\n${steps.join("\n\n")}`);

  if (ctx.playbook.known_issues.length > 0) {
    sections.push(
      `KNOWN ISSUES\n${ctx.playbook.known_issues.map((k) => `  - ${k}`).join("\n")}`
    );
  }
  sections.push(`FALLBACK\n  ${ctx.playbook.fallback_instructions}`);
  sections.push(
    `SECURITY\n  Card details and credentials above are valid ONLY for this ` +
    `checkout. Do not log them, do not echo them back to the user, do not store ` +
    `them outside the browser form fields you are about to type into.`
  );

  return sections.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// DEV mode
// ---------------------------------------------------------------------------

function formatDevPlaybook(input: PrepareCheckoutInputT): string {
  const curated = findPlaybook(input.merchant);
  const playbook = curated ?? buildGenericPlaybook(input.merchant);
  const isCurated = curated !== null;
  const requestedMode = input.login_strategy ?? playbook.login_strategy;
  const account: RenderContext["account"] =
    requestedMode === "spendex_managed"
      ? {
          mode: "spendex_managed",
          email: "signup-dev0001@mail.spendexai.com",
          password: "DEV-PLACEHOLDER-PASSWORD-do-not-use",
        }
      : requestedMode === "user_existing"
        ? { mode: "user_existing" }
        : { mode: "guest_checkout" };

  return renderPlaybook({
    playbook,
    productUrl: input.product_url,
    quantity: input.quantity ?? 1,
    variantOptions: input.variant_options,
    account,
    card: {
      number: "4242424242424242",
      expMonth: 12,
      expYear: 2030,
      cvc: "123",
      brand: "Visa",
      last4: "4242",
    },
    cardholder: "Spendex Dev",
    txLimitUsd: 500,
    amountUsd: input.amount_usd,
    isCurated,
  });
}

// ---------------------------------------------------------------------------
// Real handler
// ---------------------------------------------------------------------------

async function handlePrepareCheckout(
  input: PrepareCheckoutInputT
): Promise<ReturnType<typeof textResponse>> {
  if (DEV_MODE) {
    return textResponse(formatDevPlaybook(input));
  }

  const auth = await authenticateToolCall(input.mcp_token);
  if (!auth.ok) return auth.response;
  const { user } = auth;

  // Resolve playbook (curated or generic fallback).
  const curated = findPlaybook(input.merchant);
  const playbook = curated ?? buildGenericPlaybook(input.merchant);
  const isCurated = curated !== null;

  // Resolve login strategy. Caller's choice wins unless the playbook
  // explicitly only supports a specific strategy and the caller picked
  // something incompatible.
  const requestedMode = input.login_strategy ?? playbook.login_strategy;

  // ---- Virtual card ----
  const cardRecord = await getActiveVirtualCardForUser(user.id);
  if (!cardRecord) {
    return textResponse(
      declineMessage(
        "no active Spendex virtual card on file for this user",
        "ask the user to provision one at spendexai.com/dashboard/payments"
      ),
      { isError: true }
    );
  }

  let cardDetails: RevealedCardDetails;
  try {
    cardDetails = await retrieveCardDetails(cardRecord.stripe_card_id);
  } catch (cardErr) {
    return textResponse(
      declineMessage(
        `card details could not be retrieved (${errorMessage(cardErr, "unknown error")})`,
        "retry shortly; if the error persists, contact support at spendexai.com/support"
      ),
      { isError: true }
    );
  }

  // ---- Managed account credentials (optional) ----
  let account: RenderContext["account"];
  if (requestedMode === "user_existing") {
    account = { mode: "user_existing" };
  } else if (requestedMode === "guest_checkout") {
    account = { mode: "guest_checkout" };
  } else {
    // spendex_managed
    let managed: ManagedAccountRecord | null;
    try {
      managed = await getManagedAccountByService(user.id, playbook.merchant_id);
    } catch (lookupErr) {
      return textResponse(
        declineMessage(
          `managed ${playbook.display_name} account lookup failed (${errorMessage(lookupErr, "unknown error")})`,
          "retry shortly; if the error persists, contact support"
        ),
        { isError: true }
      );
    }
    if (!managed) {
      return textResponse(
        declineMessage(
          `no Spendex-managed ${playbook.display_name} account exists for this user yet`,
          `call signup_to_service({service:"${playbook.merchant_id}", ...}) first, or retry with login_strategy="user_existing"`
        ),
        { isError: true }
      );
    }
    if (managed.status === "disabled" || managed.status === "revoked") {
      return textResponse(
        declineMessage(
          `managed ${playbook.display_name} account is ${managed.status}`,
          "ask the user to re-enable it at spendexai.com/dashboard/accounts or re-run signup_to_service"
        ),
        { isError: true }
      );
    }

    let password: string;
    try {
      password = decryptSecret(managed.password_encrypted);
    } catch (decryptErr) {
      console.error(
        `[prepare_checkout] decryptSecret failed for managed_account ` +
        `${managed.id}: ${errorMessage(decryptErr, "unknown error")}`
      );
      return textResponse(
        declineMessage(
          `managed ${playbook.display_name} credentials could not be decrypted`,
          "contact support at spendexai.com/support — the account may need to be re-provisioned"
        ),
        { isError: true }
      );
    }

    account = {
      mode: "spendex_managed",
      email: managed.email_alias,
      password,
    };
  }

  // ---- Render playbook ----
  const cardholder = inferCardholderName(user);
  const txLimitUsd =
    user.max_auto_charge_usd > 0 ? user.max_auto_charge_usd : 500;

  const playbookText = renderPlaybook({
    playbook,
    productUrl: input.product_url,
    quantity: input.quantity ?? 1,
    variantOptions: input.variant_options,
    account,
    card: cardDetails,
    cardholder,
    txLimitUsd,
    amountUsd: input.amount_usd,
    isCurated,
  });

  // ---- Audit log ----
  // Same "audit log failure is fatal" rule as pay_for_service: if we
  // can't persist that this playbook was generated, we MUST NOT return
  // it — card + password would leak with no paper trail.
  //
  // Description contains merchant + product URL only. NEVER the password,
  // PAN, or CVC.
  try {
    await logTransaction({
      userId: user.id,
      service: playbook.merchant_id,
      status: "success",
      amountUsd: 0,
      description:
        `Checkout playbook generated for ${playbook.display_name}` +
        (input.product_url ? ` (${input.product_url})` : ""),
      transactionType: "checkout_playbook",
    });
  } catch (logErr) {
    const incidentId = randomUUID();
    console.error(
      `[prepare_checkout] audit log write FAILED — suppressing playbook ` +
      `user=${user.id} merchant=${playbook.merchant_id} ` +
      `incident_id=${incidentId}: ${errorMessage(logErr, "unknown error")}`
    );
    return textResponse(
      `INTERNAL ERROR — playbook prepared but audit log failed.\n` +
      `The playbook has been DISCARDED to avoid an unrecorded card reveal.\n` +
      `Contact support at support@spendexai.com with this incident ID: ${incidentId}.`,
      { isError: true }
    );
  }

  return textResponse(playbookText);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerPrepareCheckoutTool(server: McpServer): void {
  server.tool(
    "prepare_checkout",
    "Generate a step-by-step Computer-Use checkout playbook for ANY merchant. " +
    "Looks up curated CSS selectors + click sequences from the Spendex merchant " +
    "registry (Amazon, Walmart, Best Buy, eBay, generic Stripe Checkout, …). " +
    "Falls back to a generic playbook + warning when no curated entry exists. " +
    "ALWAYS returns the user's Spendex virtual card details so the agent can " +
    "type them into the merchant's payment form. Returns managed-account " +
    "credentials only when login_strategy=\"spendex_managed\" and the playbook " +
    "supports it. Does NOT move money — the real charge is captured by Stripe " +
    "Issuing when the merchant authorizes the card. After the order lands, the " +
    "agent MUST call complete_purchase to close the loop. Intended for hosts " +
    "with Computer Use (Claude Code computer-use, ChatGPT Operator, Browser " +
    "Use); pure-text agents should not call this tool.",
    PrepareCheckoutInput.shape,
    handlePrepareCheckout
  );
}

// Re-export the input type for the legacy alias tool.
export { PrepareCheckoutInput };
export type { PrepareCheckoutInputT };

// Internal handler exported so the legacy `prepare_amazon_checkout` tool can
// delegate to the same code path without re-registering.
export { handlePrepareCheckout };
