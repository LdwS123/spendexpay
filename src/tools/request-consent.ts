/**
 * request_user_consent — explicit confirmation prompt for critical actions.
 *
 * Agents call this BEFORE a destructive or chargeable action they cannot
 * roll back (auto-signup at a new merchant, large charge, recurring
 * subscription). The tool decides between two outcomes:
 *
 *   1. Auto-approved by the user's `user_consent_preferences` (small
 *      amounts under the threshold, or services on the trusted list) —
 *      returns immediately, no DB row written, no prompt shown.
 *
 *   2. A `consent_requests` row is created and this tool returns
 *      IMMEDIATELY with a hybrid payload:
 *         - a markdown prompt the calling agent renders as a text fallback
 *           when the host can't draw the UI widget
 *         - a JSON blob (after a `<!--SPENDEX_CONSENT_JSON-->` marker) the
 *           widget parses to populate the dialog
 *      Clients that support the MCP Apps surface render the widget
 *      (Spendex-branded consent dialog with Approve / Decline buttons).
 *      Clients that don't simply show the markdown — the contract degrades
 *      gracefully without a server-side branch.
 *
 * Email/Telegram delivery (if the user opted in) remains a best-effort
 * async fallback, not the primary flow.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import {
  createConsentRequest,
  getMonthlySpendUsd,
  getOrCreateConsentPreferences,
  getRulesForUser,
  type ConsentPreferences,
  type ConsentRequestRecord,
} from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

export const CONSENT_DIALOG_RESOURCE_URI = "ui://widgets/consent-dialog.html";

// Marker the widget looks for to find the JSON blob inside the hybrid text
// payload. Anything before this marker is the markdown fallback shown to
// non-widget clients; anything after is the structured widget payload.
const CONSENT_JSON_MARKER = "<!--SPENDEX_CONSENT_JSON-->";

// Default expiry on the consent_requests row. The agent is expected to
// surface the prompt and gather a decision well inside this window; the
// row stays addressable via check_consent_status until it lapses.
const DEFAULT_EXPIRES_SECONDS = 300;
const MAX_EXPIRES_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const ActionEnum = z
  .enum(["signup_to_service", "pay_for_service", "subscribe", "other"])
  .describe(
    "The category of action the agent wants permission for. Shapes the " +
    "default option set the user sees on the approval screen."
  );

// Exported for direct schema-validation tests. The MCP server applies this
// schema before our handler runs; tests that drive the handler directly via
// a mocked `registerTool` need access to it to exercise validation paths.
export const RequestConsentInput = z.object({
  action: ActionEnum,
  service: z
    .string()
    .min(1)
    .describe("Merchant or service slug the action targets (e.g. 'vercel')."),
  amount_usd: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Optional USD amount tied to the action. Used by the " +
      "'auto_below_threshold' policy and rendered on the prompt UI."
    ),
  context: z
    .string()
    .min(1)
    .describe(
      "Short human-readable explanation shown to the user " +
      "(e.g. \"Deploy 'my-app' to production\")."
    ),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional one-line justification rendered above the options " +
      "(e.g. \"To deploy this project, the user needs a Vercel account\")."
    ),
  options: z
    .array(z.string().min(1))
    .min(2)
    .optional()
    .describe(
      "Override the option list the user picks from. Defaults are derived " +
      "from `action` — see the tool description for the per-action set."
    ),
  expires_in_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_EXPIRES_SECONDS)
    .optional()
    .describe(
      "How long the consent_requests row stays valid before lapsing to " +
      `EXPIRED. Defaults to ${DEFAULT_EXPIRES_SECONDS}s; capped at ` +
      `${MAX_EXPIRES_SECONDS}s.`
    ),
  product_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Optional URL of the product the agent is buying. Rendered as a " +
      "clickable link in the consent widget so the user can verify the " +
      "exact item."
    ),
  product_name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Optional product title (e.g. 'Sony WH-1000XM5 Wireless Headphones'). " +
      "Shown prominently in the consent widget."
    ),
  product_image_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Optional product image URL. Rendered as a thumbnail (96x96) " +
      "in the consent widget so the user sees what they're buying."
    ),
  product_description: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional short product description. Rendered below the title."
    ),
  product_variants: z
    .array(
      z.object({
        axis: z
          .string()
          .min(1)
          .describe(
            "Variant axis label (e.g. 'color', 'size', 'storage'). " +
            "Rendered as a section title above the option chips."
          ),
        options: z
          .array(
            z.object({
              name: z
                .string()
                .min(1)
                .describe("Human label shown on the chip (e.g. 'Midnight Blue')."),
              value: z
                .string()
                .min(1)
                .describe("SKU identifier for the option (e.g. 'blue')."),
              price_delta_usd: z
                .number()
                .optional()
                .describe(
                  "Optional price adjustment in USD added on top of base_price_usd " +
                  "when this option is selected (can be negative)."
                ),
              image_url: z
                .string()
                .url()
                .optional()
                .describe(
                  "Optional image URL. If present, swaps the main product " +
                  "preview image when the chip is selected."
                ),
              available: z
                .boolean()
                .optional()
                .describe("Defaults to true. Out-of-stock chips render disabled."),
            })
          )
          .min(1)
          .describe("At least one option must be provided for each axis."),
        default_value: z
          .string()
          .optional()
          .describe(
            "Pre-select this option value when the widget opens. " +
            "Falls back to the first option if omitted or not found."
          ),
      })
    )
    .optional()
    .describe(
      "Optional product variants for an Amazon-like shopping experience. " +
      "Each axis (color, size, storage) renders as a row of chips the user " +
      "can pick. The total updates live as the user changes selections."
    ),
  min_quantity: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Minimum purchasable quantity. Defaults to 1."),
  max_quantity: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum purchasable quantity. Defaults to 1 (single-item, no picker)."
    ),
  base_price_usd: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Per-unit price before variant deltas. Used by the widget to compute " +
      "the live total. Falls back to `amount_usd` when omitted."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

type RequestConsentInputType = z.infer<typeof RequestConsentInput>;
type ConsentAction = RequestConsentInputType["action"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Default option set per action.
 *
 * signup_to_service expands beyond approve/decline so the user can choose
 * HOW Spendex creates the account (dedicated alias vs reuse, connect an
 * existing account, ...) without a second round-trip.
 */
function defaultOptionsFor(action: ConsentAction): string[] {
  switch (action) {
    case "signup_to_service":
      return [
        "auto_create_dedicated_email",
        "auto_create_my_email",
        "connect_existing",
        "decline",
      ];
    case "pay_for_service":
    case "subscribe":
    case "other":
      return ["approve", "decline"];
  }
}

/**
 * Human-readable label rendered next to each option in the inline prompt.
 *
 * The labels are intentionally agent-facing rather than user-facing: they
 * describe what each choice MEANS so the agent can paraphrase for the user
 * if it wants to. Unknown option slugs fall through to the slug itself.
 */
function describeOption(option: string, userEmail: string): string {
  switch (option) {
    case "auto_create_dedicated_email":
      return (
        "Auto-create dedicated email\n" +
        "   Spendex generates a fresh signup-*@mail.spendexai.com alias " +
        "and a strong password. The user receives no spam — emails go only " +
        "to Spendex."
      );
    case "auto_create_my_email":
      return (
        "Auto-create with my email\n" +
        `   Spendex creates the account using ${userEmail}. The user ` +
        "receives verification emails directly in their inbox."
      );
    case "connect_existing":
      return (
        "Connect existing account\n" +
        "   Connect via OAuth if the user already has an account on this " +
        "service."
      );
    case "decline":
      return (
        "Decline\n" +
        "   Do not proceed. The user will handle this manually."
      );
    case "approve":
      return (
        "Approve\n" +
        "   Proceed with the action exactly as described above."
      );
    default:
      return option;
  }
}

/**
 * Decide whether the user's preferences let us short-circuit the prompt.
 *
 * Returns the decision string we should report (e.g. "approve") when the
 * action is auto-approved, or null when a real consent_requests row must be
 * created.
 *
 * Important: we never auto-approve when the user picked `never_auto`, even
 * for a trusted service or below their threshold — that mode opts the user
 * out of all auto-approval logic.
 */
function evaluateAutoApprove(params: {
  action: ConsentAction;
  service: string;
  amountUsd: number | undefined;
  preferences: ConsentPreferences;
}): "approve" | null {
  const { service, amountUsd, preferences } = params;

  if (preferences.default_mode === "always_ask") return null;
  if (preferences.default_mode === "never_auto") return null;

  if (preferences.default_mode === "auto_below_threshold") {
    if (preferences.auto_below_threshold_usd === null) return null;
    if (amountUsd === undefined) return null;
    if (amountUsd < preferences.auto_below_threshold_usd) return "approve";
    return null;
  }

  if (preferences.default_mode === "auto_for_trusted_services") {
    const normalized = service.toLowerCase();
    const trusted = preferences.trusted_services.map((s) => s.toLowerCase());
    if (trusted.includes(normalized)) return "approve";
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rule snapshot for the widget — best-effort, never blocks
// ---------------------------------------------------------------------------

interface RuleSnapshot {
  monthly_spent: number | null;
  monthly_cap: number | null;
  per_tx_cap: number | null;
}

/**
 * Pull the user's monthly spend and aggregate spending rules so the widget
 * can render the "Within your rules:" section. This is for *display only* —
 * the authoritative enforcement happens in pay_for_service. A failure here
 * must not break consent flow; we log and return nulls so the widget
 * gracefully renders "no cap configured".
 */
async function loadRuleSnapshot(
  userId: string,
  service: string
): Promise<RuleSnapshot> {
  const snapshot: RuleSnapshot = {
    monthly_spent: null,
    monthly_cap: null,
    per_tx_cap: null,
  };

  try {
    const spent = await getMonthlySpendUsd(userId, service);
    snapshot.monthly_spent = Number.isFinite(spent) ? spent : null;
  } catch (err) {
    console.error(
      `[request_user_consent] loadRuleSnapshot: monthly spend lookup failed: ` +
      `${errorMessage(err, "unknown error")}.`
    );
  }

  try {
    const rules = await getRulesForUser(userId, service);
    // getRulesForUser returns at most one aggregated row; defensive even so.
    const aggregated = rules[0];
    if (aggregated) {
      snapshot.monthly_cap = aggregated.monthly_budget_usd ?? null;
      snapshot.per_tx_cap = aggregated.max_per_transaction_usd ?? null;
    }
  } catch (err) {
    console.error(
      `[request_user_consent] loadRuleSnapshot: rules lookup failed: ` +
      `${errorMessage(err, "unknown error")}.`
    );
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

function formatApprovedAuto(params: {
  decision: string;
  preferencesMode: ConsentPreferences["default_mode"];
}): string {
  return (
    `CONSENT APPROVED (auto-approved by user rules)\n` +
    `Decision: ${params.decision}\n` +
    `Consent ID: (auto)\n` +
    `Decided at: ${new Date().toISOString()}\n` +
    `Auto-approved by policy: ${params.preferencesMode}\n` +
    `\n` +
    `You may now proceed with the action.`
  );
}

/**
 * Resolve a variant's default selection. Falls back to the first option
 * when `default_value` is missing or doesn't match any option.
 */
function resolveVariantDefault(
  variant: NonNullable<RequestConsentInputType["product_variants"]>[number]
): NonNullable<RequestConsentInputType["product_variants"]>[number]["options"][number] {
  if (variant.default_value !== undefined) {
    const match = variant.options.find((o) => o.value === variant.default_value);
    if (match) return match;
  }
  return variant.options[0]!;
}

/**
 * Compute the initial total the markdown fallback should display. Mirrors
 * the widget's live computation but for the *default* selection set so the
 * non-widget contract stays self-explanatory.
 */
function computeDefaultTotal(input: RequestConsentInputType): number | null {
  const base =
    input.base_price_usd ??
    (input.amount_usd !== undefined ? input.amount_usd : null);
  if (base === null) return null;
  let total = base;
  if (input.product_variants) {
    for (const variant of input.product_variants) {
      const selected = resolveVariantDefault(variant);
      if (typeof selected.price_delta_usd === "number") {
        total += selected.price_delta_usd;
      }
    }
  }
  const qty = Math.max(input.min_quantity ?? 1, 1);
  return total * qty;
}

/**
 * Markdown fallback for hosts that can't render the widget. This is the same
 * shape that pre-widget clients have been consuming since v0.1 — keep it
 * verbatim so the test contract and the agent's parser stay stable.
 */
function formatConsentPromptMarkdown(params: {
  row: ConsentRequestRecord;
  input: RequestConsentInputType;
  userEmail: string;
}): string {
  const { row, input, userEmail } = params;
  const options = row.options;
  const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const optionLines = options
    .map((opt, idx) => {
      const letter = letters[idx] ?? String(idx + 1);
      return `${letter}) ${describeOption(opt, userEmail)}`;
    })
    .join("\n\n");

  const reasonLine = input.reason ? `Why: ${input.reason}\n` : "";
  const amountLine =
    input.amount_usd !== undefined
      ? `Amount: $${input.amount_usd.toFixed(2)}\n`
      : "";

  // Variants & quantity block — listed only when the agent supplied them so
  // pre-widget clients without shopping support stay byte-compatible.
  let variantsBlock = "";
  if (input.product_variants && input.product_variants.length > 0) {
    const lines: string[] = ["Variants:"];
    for (const variant of input.product_variants) {
      const def = resolveVariantDefault(variant);
      const others = variant.options
        .filter((o) => o.value !== def.value)
        .map((o) => o.name);
      const othersText =
        others.length > 0 ? ` (also available: ${others.join(", ")})` : "";
      lines.push(`  ${variant.axis}: ${def.name} (default)${othersText}`);
    }
    variantsBlock = lines.join("\n") + "\n";
  }

  const maxQty = input.max_quantity ?? 1;
  const minQty = Math.max(input.min_quantity ?? 1, 1);
  const quantityLine =
    maxQty > 1 ? `Quantity: ${minQty} (max ${maxQty})\n` : "";

  const total = computeDefaultTotal(input);
  const totalLine =
    total !== null && (input.product_variants || maxQty > 1)
      ? `\nTotal: $${total.toFixed(2)}\n`
      : "";

  // Product preview rendered as markdown image + bold name + description.
  // Clients that render markdown (Claude Code, Claude Desktop, web) will
  // display the image inline. Clients that ignore markdown still see the
  // product name and description as plain text.
  let productBlock = "";
  if (input.product_name || input.product_url || input.product_image_url) {
    if (input.product_image_url) {
      productBlock += `![${input.product_name ?? "Product"}](${input.product_image_url})\n\n`;
    }
    if (input.product_name) {
      productBlock += `**${input.product_name}**\n`;
    }
    if (input.product_description) {
      productBlock += `${input.product_description}\n`;
    }
    if (input.product_url) {
      productBlock += `[${input.product_url}](${input.product_url})\n`;
    }
    productBlock += `\n`;
  }

  const optionSlugs = options.map((o) => `"${o}"`).join(" | ");

  return (
    `CONSENT NEEDED — show this to the user and call submit_consent_decision with their choice\n` +
    `\n` +
    productBlock +
    `Action: ${input.action.replace(/_/g, " ")} (${input.service})\n` +
    reasonLine +
    `Context: ${input.context}\n` +
    amountLine +
    variantsBlock +
    quantityLine +
    totalLine +
    `\n` +
    `Options:\n` +
    optionLines +
    `\n` +
    `\n` +
    `Consent ID: ${row.id}\n` +
    `Expires at: ${row.expires_at}\n` +
    `\n` +
    `When the user chooses, call: submit_consent_decision({\n` +
    `  consent_id: "${row.id}",\n` +
    `  decision: ${optionSlugs},\n` +
    `  mcp_token: "spx_..."\n` +
    `})\n` +
    `\n` +
    `IMPORTANT: Wait for the user's actual response. Do not assume a default.`
  );
}

/**
 * Build the JSON blob the consent widget consumes. Mirrors the markdown
 * payload but in a structured shape suitable for direct rendering. Kept
 * separate so the markdown contract stays unchanged.
 */
function buildConsentJson(params: {
  row: ConsentRequestRecord;
  input: RequestConsentInputType;
  snapshot: RuleSnapshot;
  mcpToken: string;
}): Record<string, unknown> {
  const { row, input, snapshot, mcpToken } = params;
  return {
    consent_id: row.id,
    action: input.action,
    service: input.service,
    amount: input.amount_usd ?? null,
    currency: "USD",
    description: input.context,
    reason: input.reason ?? null,
    monthly_spent: snapshot.monthly_spent,
    monthly_cap: snapshot.monthly_cap,
    per_tx_cap: snapshot.per_tx_cap,
    mcp_token: mcpToken,
    options: row.options,
    expires_at: row.expires_at,
    product_url: input.product_url ?? null,
    product_name: input.product_name ?? null,
    product_image_url: input.product_image_url ?? null,
    product_description: input.product_description ?? null,
    product_variants: input.product_variants ?? null,
    min_quantity: input.min_quantity ?? 1,
    max_quantity: input.max_quantity ?? 1,
    base_price_usd:
      input.base_price_usd ??
      (input.amount_usd !== undefined ? input.amount_usd : null),
  };
}

/**
 * Compose the hybrid payload: the legacy markdown prompt for non-widget
 * clients, followed by a marker, followed by a JSON blob the widget reads
 * via `ontoolresult`. The marker is what lets the widget find the JSON
 * without misparsing the markdown above it.
 */
function formatHybridConsentPayload(params: {
  row: ConsentRequestRecord;
  input: RequestConsentInputType;
  userEmail: string;
  snapshot: RuleSnapshot;
  mcpToken: string;
}): string {
  const markdown = formatConsentPromptMarkdown({
    row: params.row,
    input: params.input,
    userEmail: params.userEmail,
  });
  const json = buildConsentJson({
    row: params.row,
    input: params.input,
    snapshot: params.snapshot,
    mcpToken: params.mcpToken,
  });
  return `${markdown}\n\n${CONSENT_JSON_MARKER}\n${JSON.stringify(json)}`;
}

function formatDevResponse(input: RequestConsentInputType): string {
  return (
    `[DEV MODE] request_user_consent called.\n` +
    `Action: ${input.action}\n` +
    `Service: ${input.service}\n` +
    (input.amount_usd !== undefined
      ? `Amount: $${input.amount_usd.toFixed(2)}\n`
      : "") +
    `Context: ${input.context}\n` +
    `\n` +
    `CONSENT APPROVED\n` +
    `Decision: approve\n` +
    `Consent ID: 00000000-0000-0000-0000-000000000000\n` +
    `Decided at: ${new Date().toISOString()}\n` +
    `Auto-approved by policy: dev_mode\n` +
    `\n` +
    `You may now proceed with the action.`
  );
}

// ---------------------------------------------------------------------------
// Notification dispatch
// ---------------------------------------------------------------------------

/**
 * Fire a best-effort POST to the dashboard notification endpoint.
 *
 * Deliberately fire-and-forget: the consent flow must NOT block on the
 * dashboard being reachable, and a delivery failure is logged but never
 * surfaced to the agent. This is an OPT-IN async fallback — the inline
 * prompt returned to the agent is the primary delivery channel.
 */
function triggerConsentNotification(
  consentId: string,
  preferences: ConsentPreferences
): void {
  // Skip entirely when the user has not configured any async channel.
  if (preferences.notification_channels.length === 0) return;

  const base = config.dashboardUrl;
  if (!base) return;

  // The dashboard rejects unauthenticated calls to /api/notify/consent.
  // Without a shared secret we'd just get a 401, so skip the call entirely
  // and warn the operator — this is a server-side misconfiguration.
  const token = config.notifyInternalToken;
  if (!token) {
    console.error(
      "[request_user_consent] NOTIFY_INTERNAL_TOKEN is not set — skipping " +
      "dashboard notification POST. Set it in the MCP server env to match " +
      "the dashboard's NOTIFY_INTERNAL_TOKEN."
    );
    return;
  }

  const url = `${base}/api/notify/consent`;
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify({ consent_id: consentId }),
  }).catch((err: unknown) => {
    console.error(
      `[request_user_consent] notification POST to ${url} failed: ` +
      `${errorMessage(err, "unknown error")}.`
    );
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerRequestConsentTool(server: McpServer): void {
  registerAppTool(
    server,
    "request_user_consent",
    {
      description:
        "Ask the user to confirm a high-stakes action (auto-signup at a new " +
        "merchant, large or recurring charge, anything destructive) BEFORE " +
        "committing to it. Honors the user's saved preferences: small charges " +
        "under their auto-approve threshold or actions on trusted services " +
        "return APPROVED immediately with no prompt shown. Otherwise returns " +
        "IMMEDIATELY (non-blocking) with a Spendex-branded consent dialog " +
        "rendered inline in chat. Hosts without UI widget support degrade to " +
        "the same structured markdown prompt the agent has always parsed — " +
        "the agent then calls `submit_consent_decision` with the user's " +
        "choice, or polls `check_consent_status` if the user steps away. " +
        "SKIP for routine small charges already covered by spending rules — " +
        "`pay_for_service` enforces those server-side.",
      inputSchema: RequestConsentInput.shape,
      _meta: { ui: { resourceUri: CONSENT_DIALOG_RESOURCE_URI } },
    },
    async (input) => {
      if (DEV_MODE) {
        return textResponse(formatDevResponse(input));
      }

      // Auth ladder: rate-limit → emergency-stop → token-format → user lookup.
      // Rate-limit runs first so timing of a bad token vs. a valid-but-unknown
      // token is indistinguishable.
      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      let preferences: ConsentPreferences;
      try {
        preferences = await getOrCreateConsentPreferences(user.id);
      } catch (err) {
        return textResponse(
          `Could not load consent preferences: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }

      const autoDecision = evaluateAutoApprove({
        action: input.action,
        service: input.service,
        amountUsd: input.amount_usd,
        preferences,
      });
      if (autoDecision !== null) {
        return textResponse(
          formatApprovedAuto({
            decision: autoDecision,
            preferencesMode: preferences.default_mode,
          })
        );
      }

      const expiresSeconds = Math.min(
        input.expires_in_seconds ?? DEFAULT_EXPIRES_SECONDS,
        MAX_EXPIRES_SECONDS
      );
      const expiresAt = new Date(Date.now() + expiresSeconds * 1000);
      const options = input.options ?? defaultOptionsFor(input.action);

      let row: ConsentRequestRecord;
      try {
        row = await createConsentRequest({
          userId: user.id,
          action: input.action,
          service: input.service,
          amountUsd: input.amount_usd,
          context: { description: input.context, reason: input.reason ?? null },
          options,
          expiresAt,
        });
      } catch (err) {
        return textResponse(
          `Could not create consent request: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }

      // Best-effort async fallback to email/Telegram. The inline widget
      // (or markdown for non-widget clients) is the primary delivery;
      // the dashboard notification only fires when the user opted into
      // async channels.
      triggerConsentNotification(row.id, preferences);

      // Snapshot of the user's spending state for the widget — best-effort.
      // A failure here returns nulls so the widget renders gracefully and
      // doesn't surface the error to the agent.
      const snapshot = await loadRuleSnapshot(user.id, input.service);

      return textResponse(
        formatHybridConsentPayload({
          row,
          input,
          userEmail: user.email,
          snapshot,
          mcpToken: input.mcp_token,
        })
      );
    }
  );
}
