/**
 * prepare_amazon_checkout — Computer-Use playbook for Amazon orders.
 *
 * Amazon's checkout is multi-page, login-gated, and littered with selector
 * variations across A/B test buckets. An agent that "just figures it out"
 * burns thousands of tokens and frequently times out before reaching the
 * place-order button. This tool short-circuits that exploration: it returns a
 * step-by-step playbook (URLs, CSS selectors, click sequence, expected
 * gotchas) tailored to the product the user wants, together with the
 * Spendex-managed login credentials and the user's virtual card details.
 *
 * The tool itself does NOT move money. The real charge is captured later by
 * Stripe Issuing when Amazon attempts to authorize the card; our existing
 * issuing webhook approves or declines that authorization against the user's
 * spending rules. This tool only:
 *
 *   1. Authenticates the caller (rate-limit → emergency-stop → token → user).
 *   2. Retrieves the user's active virtual card and reveals PAN/CVC.
 *   3. If `use_amazon_account === "spendex_managed"`, fetches the managed
 *      Amazon credentials and decrypts the password in-memory.
 *   4. Renders a deterministic playbook and writes an audit-log row of type
 *      `checkout_prepared` so the dashboard shows that the agent received
 *      Amazon checkout instructions, even before the actual order lands.
 *
 * This tool is intended for hosts that drive a real browser via Computer Use
 * (Claude Code's computer-use feature, ChatGPT Operator, etc.). Pure-text
 * agents have no way to act on a CSS selector and should not call it.
 *
 * SECURITY: the returned text contains the live PAN, CVC, and managed-account
 * password. These bytes are NEVER written to stderr, never persisted, and
 * never serialized into the audit log description. The caller (host agent)
 * must forward them to Amazon's checkout form exactly once and discard them.
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

// Same billing zip used everywhere else when we issue/return Spendex cards.
// Matches the cardholder address set in `createVirtualCardForUser` (EU/Paris).
const BILLING_ZIP = "75001";

const SERVICE_AMAZON = "amazon";

const AmazonAccountModeEnum = z
  .enum(["spendex_managed", "user_personal"])
  .describe(
    "Which Amazon account the agent will sign into. " +
    '"spendex_managed" (default) — use the Spendex-provisioned account ' +
    'tied to this user\'s managed_accounts row. ' +
    '"user_personal" — the user already drove the agent through login on ' +
    "their own amazon.com account; do not emit any credentials in the playbook."
  );

const PrepareAmazonCheckoutInput = z.object({
  product_url: z
    .string()
    .url()
    .describe(
      "Canonical Amazon product URL — typically https://www.amazon.com/dp/<ASIN>. " +
      "Used verbatim in step 2 of the playbook."
    ),
  quantity: z
    .number()
    .int()
    .positive()
    .max(99)
    .optional()
    .describe(
      "Quantity to order (default 1). Amazon's #quantity dropdown maxes out " +
      "at 30 for most items; higher values require the 'Quantity: 30+' link."
    ),
  variant_options: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Map of variant axis → chosen value (e.g. {"color": "black", "size": "M"}). ' +
      "Surfaced in step 3 so the agent clicks the right swatches. Optional — " +
      "omit for products with no variants."
    ),
  use_amazon_account: AmazonAccountModeEnum.optional(),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

type PrepareAmazonCheckoutInputT = z.infer<typeof PrepareAmazonCheckoutInput>;

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

/**
 * Best-effort cardholder name from the SpendexUser record.
 *
 * Mirrors `inferCardholderName` in pay_for_service so the value Amazon's
 * "Name on card" field expects matches the embossed cardholder. Falls back to
 * "Spendex User" when the email prefix yields nothing usable.
 */
function inferCardholderName(user: SpendexUser): string {
  const prefix = user.email.split("@")[0] ?? "";
  const cleaned = prefix.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  if (cleaned.length === 0) return "Spendex User";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ---------------------------------------------------------------------------
// Playbook rendering
// ---------------------------------------------------------------------------

interface PlaybookParams {
  productUrl: string;
  quantity: number;
  variantOptions: Record<string, string> | undefined;
  account:
    | { mode: "spendex_managed"; email: string; password: string }
    | { mode: "user_personal" };
  card: RevealedCardDetails;
  cardholder: string;
  txLimitUsd: number;
}

function renderVariantSteps(
  variantOptions: Record<string, string> | undefined
): string {
  if (!variantOptions || Object.keys(variantOptions).length === 0) {
    return (
      `Step 3 — Select variant (if applicable)\n` +
      `  No variants supplied. If Amazon offers any (color, size, style), pick ` +
      `the default highlighted swatch or ABORT and ask the user to clarify.\n`
    );
  }
  const lines: string[] = [`Step 3 — Select variant\n`];
  for (const [axis, value] of Object.entries(variantOptions)) {
    // Selectors are intentionally generic: Amazon ships a different attribute
    // for each axis (twister_*, color_name, size_name, …). We tell the agent
    // *what* to click rather than try to predict the exact selector for every
    // product type, because A/B buckets vary too widely to lock down.
    lines.push(
      `  Click ${axis} "${value}": ` +
      `[id*="${axis}_name"] [title*="${value}" i], ` +
      `or any swatch button with aria-label matching "${value}".\n`
    );
  }
  return lines.join("");
}

function renderLoginStep(account: PlaybookParams["account"]): string {
  if (account.mode === "user_personal") {
    return (
      `Step 1 — Login (user_personal mode)\n` +
      `  Do NOT emit credentials. The user is expected to be already signed in ` +
      `to their own amazon.com account in this browser session.\n` +
      `  If amazon.com redirects to /ap/signin, ABORT and call ` +
      `request_user_consent({action:"other", service:"amazon", ` +
      `context:"Amazon requires login; user must complete it manually"}).\n`
    );
  }
  return (
    `Step 1 — Login (if not already)\n` +
    `  URL: https://www.amazon.com/ap/signin\n` +
    `  Email: ${account.email}\n` +
    `  Password: ${account.password}\n` +
    `  Selectors: #ap_email, #continue, #ap_password, #signInSubmit\n` +
    `  Sequence:\n` +
    `    1. Fill #ap_email with the email above, click #continue.\n` +
    `    2. Fill #ap_password with the password above, click #signInSubmit.\n`
  );
}

function renderPaymentStep(
  card: RevealedCardDetails,
  cardholder: string,
  txLimitUsd: number
): string {
  const grouped = card.number.match(/.{1,4}/g)?.join(" ") ?? card.number;
  const expMonth = String(card.expMonth).padStart(2, "0");
  const expYear = String(card.expYear).slice(-2);
  return (
    `Step 8 — Payment method (use the Spendex virtual card)\n` +
    `  If "Add a credit or debit card" prompt:\n` +
    `    Card number: ${grouped}\n` +
    `    Name: ${cardholder}\n` +
    `    Expiration MM/YY: ${expMonth}/${expYear}\n` +
    `    CVV: ${card.cvc}\n` +
    `    Billing zip: ${BILLING_ZIP}\n` +
    `    Selectors: input[name="addCreditCardNumber"], ` +
    `input[name="addCreditCardName"], ` +
    `select[name="ccMonth"], select[name="ccYear"], ` +
    `input[name="addCreditCardVerificationNumber"]\n` +
    `  If the Spendex card (ending ${card.last4}) is already listed, click ` +
    `"Use this card" / the matching radio.\n` +
    `  Per-authorization cap enforced by Stripe Issuing: ` +
    `$${txLimitUsd.toFixed(2)}. Authorizations above this amount will decline.\n`
  );
}

function renderPlaybook(params: PlaybookParams): string {
  const {
    productUrl,
    quantity,
    variantOptions,
    account,
    card,
    cardholder,
    txLimitUsd,
  } = params;

  return (
    `AMAZON CHECKOUT PLAYBOOK\n` +
    `\n` +
    renderLoginStep(account) +
    `\n` +
    `Step 2 — Navigate to product\n` +
    `  URL: ${productUrl}\n` +
    `\n` +
    renderVariantSteps(variantOptions) +
    `\n` +
    `Step 4 — Set quantity\n` +
    `  Selector: #quantity (dropdown)\n` +
    `  Value: ${quantity}\n` +
    `\n` +
    `Step 5 — Add to cart\n` +
    `  Button: #add-to-cart-button\n` +
    `  Wait for confirmation banner: #huc-v2-order-row-confirm-text, ` +
    `or "Added to Cart" toast (#nav-cart-count increments by ${quantity}).\n` +
    `\n` +
    `Step 6 — Proceed to checkout\n` +
    `  Button: #hlb-ptc-btn-native (cart-side button),\n` +
    `  OR navigate directly to https://www.amazon.com/gp/cart/view.html and ` +
    `click "Proceed to checkout".\n` +
    `\n` +
    `Step 7 — Shipping address\n` +
    `  If Amazon prompts to select an address: click "Use this address" on the ` +
    `Spendex-managed address that matches the cardholder name above.\n` +
    `  If NO address is saved, add one with:\n` +
    `    Name: ${cardholder}\n` +
    `    Street: 1 Spendex Street\n` +
    `    City: Paris\n` +
    `    Zip: ${BILLING_ZIP}\n` +
    `    Country: France\n` +
    `\n` +
    renderPaymentStep(card, cardholder, txLimitUsd) +
    `\n` +
    `Step 9 — Review & place order\n` +
    `  Verify the order total before clicking. If it exceeds the Stripe ` +
    `Issuing per-authorization cap ($${txLimitUsd.toFixed(2)}), ABORT and ` +
    `call request_user_consent with the actual total.\n` +
    `  Button: #placeYourOrder1, or button[name="placeYourOrder1"], ` +
    `or "Place your order" inside #submitOrderButtonId.\n` +
    `\n` +
    `Step 10 — Capture order ID\n` +
    `  After redirect, Amazon lands on https://www.amazon.com/gp/buy/thankyou/handlers/…\n` +
    `  Extract the order ID. It appears as "Order # XXX-XXXXXXX-XXXXXXX" — ` +
    `selectors: span#orderId, or scrape the page text with the regex ` +
    `/Order #\\s*([0-9]{3}-[0-9]{7}-[0-9]{7})/.\n` +
    `\n` +
    `Step 11 — Report back\n` +
    `  Call complete_purchase({\n` +
    `    merchant: "amazon",\n` +
    `    external_order_id: "<captured order ID>",\n` +
    `    amount_usd: <observed order total>,\n` +
    `    mcp_token: "<this same token>"\n` +
    `  }) so Spendex closes the loop in the audit log and links the order to ` +
    `the wallet.\n` +
    `\n` +
    `KNOWN GOTCHAS\n` +
    `  - Amazon may show a "Choose a different shipping speed" page. Pick ` +
    `"Standard" (cheapest) unless the user asked otherwise.\n` +
    `  - 2FA / SMS OTP: if Amazon shows the auth-challenge page (URL contains ` +
    `/ap/mfa or /ap/cvf), ABORT and call request_user_consent({action:"other", ` +
    `service:"amazon", context:"Amazon SMS 2FA challenge"}). Do not guess.\n` +
    `  - Captcha: if shown, ABORT and surface to the user — do not attempt to ` +
    `solve.\n` +
    `  - Buy Now (express): faster path that skips the cart entirely, but it ` +
    `uses the default address + payment method without prompting. Only take it ` +
    `if Step 7's address and Step 8's card are already on file and confirmed.\n` +
    `  - Region redirect: if Amazon redirects you to amazon.fr / .de / .co.uk, ` +
    `do NOT proceed — the managed account is bound to amazon.com. Force ` +
    `amazon.com via the bottom-of-page "Change country/region" link.\n` +
    `\n` +
    `SECURITY\n` +
    `  Card details and password above are valid ONLY for this checkout. ` +
    `Do not log them, do not echo them back to the user, do not store them ` +
    `outside the browser form fields you are about to type into.\n`
  );
}

/**
 * Format the simulated DEV-mode response. Realistic enough that an integrator
 * can iterate on the agent's parsing logic, but the card and password values
 * are obvious placeholders so nothing leaks if it gets accidentally logged.
 */
function formatDevPlaybook(input: PrepareAmazonCheckoutInputT): string {
  const quantity = input.quantity ?? 1;
  const mode = input.use_amazon_account ?? "spendex_managed";
  return renderPlaybook({
    productUrl: input.product_url,
    quantity,
    variantOptions: input.variant_options,
    account:
      mode === "user_personal"
        ? { mode: "user_personal" }
        : {
            mode: "spendex_managed",
            email: "signup-dev0001@mail.spendexai.com",
            password: "DEV-PLACEHOLDER-PASSWORD-do-not-use",
          },
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
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerPrepareAmazonCheckoutTool(server: McpServer): void {
  server.tool(
    "prepare_amazon_checkout",
    "Generate a step-by-step Amazon.com checkout playbook for a Computer-Use " +
    "agent (Claude Code computer-use, ChatGPT Operator, Browser Use, etc.). " +
    "Returns the exact URL/click/selector sequence to add the item to cart, " +
    "fill the address, type in the Spendex virtual card, and place the order, " +
    "plus the Spendex-managed login credentials when " +
    "use_amazon_account=\"spendex_managed\". Does NOT move money on its own — " +
    "the actual charge is captured by Stripe Issuing when Amazon authorizes " +
    "the card, which our webhook approves against the user's spending rules. " +
    "After the order lands, the agent MUST call complete_purchase to close the " +
    "loop. Intended for agents that can drive a real browser; pure-text " +
    "agents should not call this tool.",
    PrepareAmazonCheckoutInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(formatDevPlaybook(input));
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      const quantity = input.quantity ?? 1;
      const mode = input.use_amazon_account ?? "spendex_managed";

      // ---- Virtual card ----
      // Same gate as pay_for_service: no active card on file → decline before
      // we touch the managed_accounts table. There is no point exposing
      // credentials the agent cannot pair with a working payment method.
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
      let account: PlaybookParams["account"];
      if (mode === "user_personal") {
        account = { mode: "user_personal" };
      } else {
        let managed: ManagedAccountRecord | null;
        try {
          managed = await getManagedAccountByService(user.id, SERVICE_AMAZON);
        } catch (lookupErr) {
          return textResponse(
            declineMessage(
              `managed Amazon account lookup failed (${errorMessage(lookupErr, "unknown error")})`,
              "retry shortly; if the error persists, contact support"
            ),
            { isError: true }
          );
        }
        if (!managed) {
          return textResponse(
            declineMessage(
              "no Spendex-managed Amazon account exists for this user yet",
              'call signup_to_service({service:"amazon", ...}) first, or retry with use_amazon_account="user_personal"'
            ),
            { isError: true }
          );
        }
        if (managed.status === "disabled" || managed.status === "revoked") {
          return textResponse(
            declineMessage(
              `managed Amazon account is ${managed.status}`,
              "ask the user to re-enable it at spendexai.com/dashboard/accounts or re-run signup_to_service"
            ),
            { isError: true }
          );
        }

        let password: string;
        try {
          password = decryptSecret(managed.password_encrypted);
        } catch (decryptErr) {
          // Don't surface the crypto error to the agent verbatim — it tends
          // to mention key sizes / IV layout, which is operational noise.
          console.error(
            `[prepare_amazon_checkout] decryptSecret failed for managed_account ` +
            `${managed.id}: ${errorMessage(decryptErr, "unknown error")}`
          );
          return textResponse(
            declineMessage(
              "managed Amazon credentials could not be decrypted",
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

      const playbook = renderPlaybook({
        productUrl: input.product_url,
        quantity,
        variantOptions: input.variant_options,
        account,
        card: cardDetails,
        cardholder,
        txLimitUsd,
      });

      // ---- Audit log ----
      // Same "audit log failure is fatal" rule as pay_for_service: if we
      // can't persist that this playbook was generated, we must NOT return
      // it — otherwise card + password leak with no paper trail.
      //
      // Description contains the product URL only. NEVER the password, PAN,
      // or CVC. The audit log is read by support / the dashboard and must
      // remain safe to display in clear.
      try {
        await logTransaction({
          userId: user.id,
          service: SERVICE_AMAZON,
          status: "success",
          amountUsd: 0,
          description: `Amazon checkout playbook generated for ${input.product_url}`,
          transactionType: "checkout_prepared",
        });
      } catch (logErr) {
        const incidentId = randomUUID();
        // Do NOT include card / password in the stderr line. The product URL
        // is fine — it's the only identifying piece of context we have left
        // when card data is forbidden in logs.
        console.error(
          `[prepare_amazon_checkout] audit log write FAILED — suppressing playbook ` +
          `user=${user.id} product=${input.product_url} ` +
          `incident_id=${incidentId}: ${errorMessage(logErr, "unknown error")}`
        );
        return textResponse(
          `INTERNAL ERROR — playbook prepared but audit log failed.\n` +
          `The playbook has been DISCARDED to avoid an unrecorded card reveal.\n` +
          `Contact support at support@spendexai.com with this incident ID: ${incidentId}.`,
          { isError: true }
        );
      }

      return textResponse(playbook);
    }
  );
}
