/**
 * pay_for_service — the universal payment tool.
 *
 * One generic entrypoint that replaces the older service-specific tools
 * (deploy_to_vercel, subscribe_to_service, add_service_credits). An agent
 * names any merchant ("vercel", "modal", "openai", …) and an amount; this
 * tool authorizes the charge against the user's spending rules, then either
 *
 *   1. ("native_api")  — calls the merchant's API directly via the user's
 *      OAuth token. No native integrations exist in v1; reserved for future.
 *   2. ("card_reveal") — returns the user's virtual card details so the
 *      agent can pay through the merchant's normal checkout. Stripe Issuing
 *      enforces the per-authorization limit when the merchant attempts the
 *      charge; our webhook approves or declines in real time.
 *
 * All output is plain text formatted for an LLM agent — when we decline
 * we explain *why* and suggest a next step the agent can take.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import {
  createConsentRequest,
  getActiveVirtualCardForUser,
  getMonthlyCategorySpendUsd,
  getMonthlySpendUsd,
  getOrCreateConsentPreferences,
  getRulesForUser,
  logTransaction,
  recordConsentDecision,
  type ConsentPreferences,
  type ConsentRequestRecord,
  type SpendexRule,
  type SpendexUser,
} from "../lib/db.js";
import { acquireIdempotencyKey, releaseIdempotencyKey } from "../lib/idempotency.js";
import { classifyIntent, type IntentClassification } from "../lib/intent-classifier.js";
import { retrieveCardDetails, type RevealedCardDetails } from "../lib/stripe-issuing.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

// ---------------------------------------------------------------------------
// MCP elicitation — minimal structural typing
//
// We do not import the SDK's ElicitResult shape directly because elicitInput
// lives on the underlying `Server` (McpServer.server) and its parameter/return
// types are not re-exported under a stable public name across SDK versions.
// Capturing just the fields we read keeps the tool resilient to upstream
// refactors and keeps `any` out of the codebase.
// ---------------------------------------------------------------------------

interface ElicitInputRequest {
  mode: "form";
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

interface ElicitInputResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

interface ElicitCapable {
  elicitInput(req: ElicitInputRequest): Promise<ElicitInputResult>;
}

// Billing zip used on the issued virtual card. Matches the address used by
// dashboard/src/app/api/onboarding (EU accounts → Paris/75001). When we add
// US support this will be derived per-user from the cardholder record.
const BILLING_ZIP = "75001";

const PaymentMethodEnum = z
  .enum(["auto", "card_reveal", "native_api"])
  .describe(
    "How the payment should be settled. " +
    '"auto" (default) lets Spendex pick the best method for this merchant. ' +
    '"card_reveal" returns the user\'s virtual card details so the agent can ' +
    "type them into the merchant's checkout. " +
    '"native_api" charges via a direct API integration (when one exists).'
  );

const PayForServiceInput = z.object({
  service: z
    .string()
    .min(1)
    .describe("Merchant or service name (e.g. 'vercel', 'modal', 'openai')."),
  amount_usd: z
    .number()
    .positive()
    .describe("Charge amount in USD. Must be greater than zero."),
  description: z
    .string()
    .min(1)
    .describe(
      "Short human-readable reason for the charge, written for the END USER " +
      "(e.g. 'Upgrade my-app to Vercel Pro plan'). Appears on the user's " +
      "audit log and dashboard receipts — keep it specific and concrete."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
  payment_method: PaymentMethodEnum.optional(),
});

type PaymentMethodPreference = z.infer<typeof PaymentMethodEnum>;

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

/**
 * Format a decline message the agent can actually act on.
 *
 * The "Your agent should:" line is deliberate — agents read this back and use
 * it to choose the next step (notify the user, retry with a smaller amount,
 * pick a different service, etc.).
 */
function declineMessage(reason: string, suggestion: string): string {
  return `PAYMENT DECLINED: ${reason}. Your agent should: ${suggestion}.`;
}

/**
 * Native integrations registry. Empty in v1; populated as we add direct API
 * integrations (e.g. an OAuth-backed Vercel deploy that bypasses card entry).
 * Until a service appears here, "auto" always falls back to card_reveal.
 */
const NATIVE_INTEGRATIONS: ReadonlySet<string> = new Set<string>();

function hasNativeIntegration(service: string): boolean {
  return NATIVE_INTEGRATIONS.has(service.toLowerCase());
}

// ---------------------------------------------------------------------------
// Inline consent (MCP elicitation)
//
// `pay_for_service` may need user confirmation before charging — for example
// when the user's `default_mode` is `always_ask`, the amount is above their
// auto-approve threshold, or the merchant is not in their trusted list. When
// the host client supports MCP elicitation we render a native dialog inline
// in the chat; the user clicks Approve/Decline, and the same tool call
// resumes. When the host does NOT support elicitation (older clients,
// background tasks, …) we fall back to the existing text-based prompt that
// instructs the agent to call `submit_consent_decision`.
// ---------------------------------------------------------------------------

/**
 * Decide whether this charge needs an explicit user confirmation.
 *
 * Mirrors the policy applied by `request_user_consent` so the two surfaces
 * stay in sync — if either tool would prompt for this combination, both do.
 */
function consentRequired(params: {
  service: string;
  amountUsd: number;
  preferences: ConsentPreferences;
}): boolean {
  const { service, amountUsd, preferences } = params;

  switch (preferences.default_mode) {
    case "always_ask":
    case "never_auto":
      return true;
    case "auto_below_threshold": {
      // Threshold not configured → fall back to "ask".
      if (preferences.auto_below_threshold_usd === null) return true;
      return amountUsd >= preferences.auto_below_threshold_usd;
    }
    case "auto_for_trusted_services": {
      const normalized = service.toLowerCase();
      const trusted = preferences.trusted_services.map((s) => s.toLowerCase());
      return !trusted.includes(normalized);
    }
  }
}

/**
 * Best-effort feature detection — only attempt elicitation when the underlying
 * Server exposes the method. We do not pre-read client capabilities ourselves;
 * the SDK throws "Client does not support form elicitation." if the client
 * never advertised the capability, and we catch that into the text fallback.
 */
function asElicitCapable(srv: unknown): ElicitCapable | null {
  if (srv === null || typeof srv !== "object") return null;
  const candidate = srv as { elicitInput?: unknown };
  if (typeof candidate.elicitInput !== "function") return null;
  return srv as ElicitCapable;
}

/**
 * Format the message body shown inside the native elicitation dialog.
 *
 * The host client renders this verbatim above the Approve/Decline buttons,
 * so we want a tight, scannable summary — service, amount, description.
 */
function formatElicitPrompt(params: {
  service: string;
  amountUsd: number;
  description: string;
}): string {
  return (
    `Spendex requests your permission:\n\n` +
    `Pay $${params.amountUsd.toFixed(2)} on ${params.service}\n` +
    params.description
  );
}

/**
 * Render the text-based consent prompt used when MCP elicitation is not
 * available on the host client.
 *
 * The shape matches the existing `request_user_consent` prompt so agents that
 * already know how to relay that surface need no special handling here. The
 * consent_requests row id is included so the agent can report the user's
 * decision back via `submit_consent_decision`.
 */
function formatTextConsentFallback(params: {
  service: string;
  amountUsd: number;
  description: string;
  row: ConsentRequestRecord;
}): string {
  return (
    `CONSENT NEEDED — show this to the user and call submit_consent_decision with their choice\n` +
    `\n` +
    `Action: pay for service (${params.service})\n` +
    `Amount: $${params.amountUsd.toFixed(2)}\n` +
    `Context: ${params.description}\n` +
    `\n` +
    `Options:\n` +
    `A) Approve\n` +
    `   Proceed with the charge as described above.\n` +
    `\n` +
    `B) Decline\n` +
    `   Do not proceed. The user will handle this manually.\n` +
    `\n` +
    `Consent ID: ${params.row.id}\n` +
    `Expires at: ${params.row.expires_at}\n` +
    `\n` +
    `When the user chooses, call: submit_consent_decision({\n` +
    `  consent_id: "${params.row.id}",\n` +
    `  decision: "approve" | "decline",\n` +
    `  mcp_token: "spx_..."\n` +
    `})\n` +
    `\n` +
    `IMPORTANT: Wait for the user's actual response. Do not assume a default.`
  );
}

// How long a consent_requests row created inline by pay_for_service stays
// addressable before it auto-expires. Matches the default used by
// `request_user_consent`.
const INLINE_CONSENT_EXPIRY_SECONDS = 300;

interface InlineConsentOutcome {
  /** True when the user approved and the caller should proceed to charge. */
  approved: boolean;
  /** Plain-text payload to return to the agent when `approved` is false. */
  declineResponse?: ReturnType<typeof textResponse>;
}

/**
 * Drive the inline-consent flow end to end.
 *
 * Creates a `consent_requests` row in `pending` so the audit log captures the
 * prompt even if the client crashes mid-call, attempts MCP elicitation, then
 * updates the row to approved/declined (via `recordConsentDecision`) based on
 * the user's choice. Returns:
 *   - `{ approved: true }`  → caller proceeds to card reveal.
 *   - `{ approved: false, declineResponse }` → caller returns declineResponse.
 *
 * Falls back to the legacy text prompt (and leaves the row pending) when the
 * host client does not support elicitation. In that case the agent must call
 * `submit_consent_decision` to settle the row before the charge proceeds.
 */
async function runInlineConsentFlow(params: {
  server: McpServer;
  user: SpendexUser;
  service: string;
  amountUsd: number;
  description: string;
}): Promise<InlineConsentOutcome> {
  const { server, user, service, amountUsd, description } = params;

  // Always create the row first so the audit log reflects the attempt even
  // if the client drops the request mid-flight. Failure to create is fatal
  // for the consent flow — we surface it and decline rather than charging
  // without consent.
  let row: ConsentRequestRecord;
  try {
    row = await createConsentRequest({
      userId: user.id,
      action: "pay_for_service",
      service,
      amountUsd,
      context: { description, source: "pay_for_service_elicit" },
      options: ["approve", "decline"],
      expiresAt: new Date(Date.now() + INLINE_CONSENT_EXPIRY_SECONDS * 1000),
    });
  } catch (err) {
    return {
      approved: false,
      declineResponse: textResponse(
        `Could not record consent request: ${errorMessage(err, "unknown error")}. ` +
        `Your account was not charged.`,
        { isError: true }
      ),
    };
  }

  const elicit = asElicitCapable(server.server);

  // Host client doesn't expose elicitation — return the text fallback. The
  // row stays pending; `submit_consent_decision` will settle it when the
  // agent reports the user's choice back to us.
  if (elicit === null) {
    console.error(
      `[pay_for_service] consent fallback (no elicitInput) user=${user.id} ` +
      `service=${service} consent_id=${row.id}`
    );
    await logTransaction({
      userId: user.id,
      service,
      status: "payment_failed",
      amountUsd,
      description: `${description} — consent prompt deferred (text fallback)`,
      transactionType: "consent_pending",
      error: "client does not support elicitation; awaiting submit_consent_decision",
    });
    return {
      approved: false,
      declineResponse: textResponse(
        formatTextConsentFallback({ service, amountUsd, description, row })
      ),
    };
  }

  // Attempt the native dialog. The SDK throws synchronously-rejected
  // promises when the client never advertised elicitation; we catch and
  // fall back to the text prompt so consent is still possible.
  let result: ElicitInputResult;
  try {
    console.error(
      `[pay_for_service] elicitation requested user=${user.id} ` +
      `service=${service} amount=${amountUsd} consent_id=${row.id}`
    );
    result = await elicit.elicitInput({
      mode: "form",
      message: formatElicitPrompt({ service, amountUsd, description }),
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            enum: ["approve", "decline"],
            enumNames: ["Approve & pay", "Decline"],
          },
        },
        required: ["decision"],
      },
    });
  } catch (err) {
    console.error(
      `[pay_for_service] elicitation failed user=${user.id} ` +
      `service=${service} consent_id=${row.id}: ` +
      `${errorMessage(err, "unknown error")} — falling back to text prompt`
    );
    await logTransaction({
      userId: user.id,
      service,
      status: "payment_failed",
      amountUsd,
      description: `${description} — consent prompt deferred (elicit unsupported)`,
      transactionType: "consent_pending",
      error: `elicitation unavailable: ${errorMessage(err, "unknown error")}`,
    });
    return {
      approved: false,
      declineResponse: textResponse(
        formatTextConsentFallback({ service, amountUsd, description, row })
      ),
    };
  }

  // ---- Interpret the dialog result ----

  if (result.action === "accept") {
    const decision =
      result.content && typeof result.content["decision"] === "string"
        ? (result.content["decision"] as string)
        : null;

    if (decision === "approve") {
      console.error(
        `[pay_for_service] consent approved via elicit user=${user.id} ` +
        `service=${service} consent_id=${row.id}`
      );
      try {
        await recordConsentDecision({
          id: row.id,
          userId: user.id,
          status: "approved",
          decision: "approve",
          decisionMetadata: { source: "pay_for_service_elicit" },
        });
      } catch (err) {
        // Best effort — we already have the user's "yes" in hand. Log and
        // continue; the audit log row below still captures the event.
        console.error(
          `[pay_for_service] recordConsentDecision(approved) failed ` +
          `consent_id=${row.id}: ${errorMessage(err, "unknown error")}`
        );
      }
      return { approved: true };
    }

    // Treat any other accept-payload (decision === "decline", or an
    // unexpected value the client somehow let through) as a decline.
    console.error(
      `[pay_for_service] consent declined via elicit user=${user.id} ` +
      `service=${service} consent_id=${row.id} decision=${decision ?? "null"}`
    );
    try {
      await recordConsentDecision({
        id: row.id,
        userId: user.id,
        status: "declined",
        decision: "decline",
        decisionMetadata: { source: "pay_for_service_elicit" },
      });
    } catch (err) {
      console.error(
        `[pay_for_service] recordConsentDecision(declined) failed ` +
        `consent_id=${row.id}: ${errorMessage(err, "unknown error")}`
      );
    }
    await logTransaction({
      userId: user.id,
      service,
      status: "payment_failed",
      amountUsd,
      description: `${description} — consent declined via elicit`,
      transactionType: "consent_declined",
      error: "user declined inline consent prompt",
    });
    return {
      approved: false,
      declineResponse: textResponse(
        `PAYMENT DECLINED by user via inline consent for ${service} ($${amountUsd.toFixed(2)}). ` +
        `Your agent should: acknowledge the user's choice and not retry without explicit instruction.`
      ),
    };
  }

  // action === "decline" or "cancel" → user dismissed the prompt. Settle the
  // row as declined for audit purposes but report a softer message back so
  // the agent doesn't conflate "user said no" with "user closed the dialog".
  console.error(
    `[pay_for_service] consent ${result.action} via elicit user=${user.id} ` +
    `service=${service} consent_id=${row.id}`
  );
  try {
    await recordConsentDecision({
      id: row.id,
      userId: user.id,
      status: "declined",
      decision: result.action === "cancel" ? "cancel" : "decline",
      decisionMetadata: { source: "pay_for_service_elicit", action: result.action },
    });
  } catch (err) {
    console.error(
      `[pay_for_service] recordConsentDecision(${result.action}) failed ` +
      `consent_id=${row.id}: ${errorMessage(err, "unknown error")}`
    );
  }
  await logTransaction({
    userId: user.id,
    service,
    status: "payment_failed",
    amountUsd,
    description: `${description} — consent ${result.action} via elicit`,
    transactionType: "consent_declined",
    error: `user ${result.action}ed inline consent prompt`,
  });
  return {
    approved: false,
    declineResponse: textResponse(
      `PAYMENT CANCELED — user dismissed the consent prompt for ${service} ($${amountUsd.toFixed(2)}). ` +
      `Your agent should: surface this back to the user and wait for explicit re-instruction before retrying.`
    ),
  };
}

// ---------------------------------------------------------------------------
// Rules evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate every active rule against the proposed charge.
 *
 * Returns a decline reason (plain English, no stack traces) or null if the
 * charge is allowed. Checks run in cheap-to-expensive order so we never
 * touch the audit-log table when a per-transaction rule already declines.
 */
async function evaluateRules(params: {
  userId: string;
  service: string;
  amountUsd: number;
  userMaxAutoCharge: number;
  rules: SpendexRule[];
  classification: IntentClassification;
}): Promise<string | null> {
  const { userId, service, amountUsd, userMaxAutoCharge, rules, classification } = params;
  const normalizedService = service.toLowerCase();
  const classificationCategory = (typeof classification.category === "string"
    ? classification.category
    : "unknown"
  ).toLowerCase();

  // 1. Merchant allow/block lists — cheapest checks.
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

  // 1.5 Smart rules — category blocklist, risk threshold, urgency-requires-
  //     consent. These run BEFORE the numeric caps so a clearly-disallowed
  //     category (gambling, crypto, …) declines with the specific reason
  //     rather than getting swallowed by a generic "per-transaction cap"
  //     message. Category caps that need a DB read come later (step 4.5).
  for (const rule of rules) {
    // category_blocklist — decline if the LLM-classified category is in the
    // user's blocklist. Match is case-insensitive.
    if (rule.category_blocklist && rule.category_blocklist.length > 0) {
      const blockedCats = rule.category_blocklist.map((c) => c.toLowerCase());
      if (blockedCats.includes(classificationCategory)) {
        return declineMessage(
          `the category "${classificationCategory}" is on the user's blocked-categories list ` +
          `(classifier reasoning: ${classification.reasoning})`,
          "ask the user to remove it from spendexai.com/dashboard/rules or pick a different merchant"
        );
      }
    }

    // risk_threshold — decline if the LLM risk score exceeds the user's cap.
    if (
      rule.risk_threshold !== null &&
      rule.risk_threshold !== undefined &&
      classification.risk_score > rule.risk_threshold
    ) {
      return declineMessage(
        `this purchase has an AI risk score of ${classification.risk_score}/100, ` +
        `above the user's threshold of ${rule.risk_threshold} ` +
        `(classifier reasoning: ${classification.reasoning})`,
        "ask the user to confirm explicitly via request_user_consent, " +
        "or pick a less risky merchant"
      );
    }

    // urgency_requires_consent — high-urgency purchases need explicit consent.
    // We don't drive the consent dialog inline here (the consent gate below
    // handles that); instead we decline with a directive so the agent knows
    // to call request_user_consent before retrying.
    if (rule.urgency_requires_consent && classification.urgency === "high") {
      return declineMessage(
        `this purchase is classified as high-urgency and the user requires ` +
        `explicit consent for high-urgency charges ` +
        `(classifier reasoning: ${classification.reasoning})`,
        "call request_user_consent first; once the user approves, retry pay_for_service"
      );
    }
  }

  // 2. Per-service per-transaction cap — narrower than the global per-tx cap
  //    and evaluated first so the decline message names the specific service
  //    that blocked the charge (e.g. "monthly cap for vercel exceeded …").
  //    `getRulesForUser` returns at most one synthetic rule with the per
  //    service caps already matched to this service.
  for (const rule of rules) {
    if (rule.per_service_per_tx_cap_usd === null) continue;
    if (amountUsd > rule.per_service_per_tx_cap_usd) {
      return declineMessage(
        `per-transaction cap for ${service} exceeded ` +
        `($${amountUsd.toFixed(2)} attempted, $${rule.per_service_per_tx_cap_usd.toFixed(2)} cap)`,
        `ask the user to raise the ${service} per-transaction cap at spendexai.com/dashboard/rules ` +
        "or retry with a smaller amount"
      );
    }
  }

  // 3. Global per-transaction cap — combine the user's max_auto_charge_usd
  //    with the tightest per-rule per-transaction cap. A `max_auto_charge_usd`
  //    of 0 means "no auto-approval threshold configured" — skip that side.
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
      "ask the user to confirm this charge or raise the cap at spendexai.com/dashboard/rules, " +
      "or retry with a smaller amount"
    );
  }

  // 4. Per-service monthly cap — requires its own DB read filtered to the
  //    target service. Done before the global monthly check so the agent
  //    sees the most specific reason a charge was blocked.
  const perServiceMonthlyRule = rules.find(
    (r) => r.per_service_monthly_cap_usd !== null
  );
  const spendCache = new Map<string, number>();
  async function spendFor(filter: string | null): Promise<number> {
    const key = filter ?? "__all__";
    const cached = spendCache.get(key);
    if (cached !== undefined) return cached;
    const value = await getMonthlySpendUsd(userId, filter ?? undefined);
    spendCache.set(key, value);
    return value;
  }

  if (perServiceMonthlyRule) {
    const cap = perServiceMonthlyRule.per_service_monthly_cap_usd as number;
    const spent = await spendFor(service);
    if (spent + amountUsd > cap) {
      return declineMessage(
        `monthly cap for ${service} exceeded ` +
        `($${spent.toFixed(2)} spent, $${cap.toFixed(2)} cap, this charge $${amountUsd.toFixed(2)} ` +
        `would bring to $${(spent + amountUsd).toFixed(2)})`,
        `ask the user to raise the ${service} monthly cap at spendexai.com/dashboard/rules, ` +
        "wait until next month, or split the charge into smaller pieces"
      );
    }
  }

  // 4.5 Per-category monthly cap — same logic as per-service monthly cap but
  //     keyed on the classifier's category instead of the merchant name.
  //     E.g. "max $50/mo on entertainment" applies whether the user spends
  //     on Netflix, Spotify, or Disney+. DB read only happens when a cap
  //     for the current category exists, so this is free for users without
  //     category rules configured.
  for (const rule of rules) {
    if (!rule.category_caps) continue;
    const cap = rule.category_caps[classificationCategory];
    if (cap === undefined) continue;
    const spent = await getMonthlyCategorySpendUsd(userId, classificationCategory);
    if (spent + amountUsd > cap) {
      return declineMessage(
        `monthly cap for category "${classificationCategory}" exceeded ` +
        `($${spent.toFixed(2)} spent, $${cap.toFixed(2)} cap, this charge $${amountUsd.toFixed(2)} ` +
        `would bring to $${(spent + amountUsd).toFixed(2)})`,
        `ask the user to raise the ${classificationCategory} category cap at ` +
        "spendexai.com/dashboard/rules, wait until next month, or pick a merchant " +
        "in a different category"
      );
    }
  }

  // 5. Global monthly budget — same cache so a user who has BOTH a global
  //    budget AND a per-service cap only pays one DB hit per filter scope.
  const monthlyRules = rules.filter((r) => r.monthly_budget_usd !== null);
  if (monthlyRules.length === 0) return null;

  for (const rule of monthlyRules) {
    const budget = rule.monthly_budget_usd as number;
    const spent = await spendFor(rule.service_filter);
    if (spent + amountUsd > budget) {
      const scope = rule.service_filter ?? "all services";
      return declineMessage(
        `$${amountUsd.toFixed(2)} would push this month's ${scope} spend to ` +
        `$${(spent + amountUsd).toFixed(2)}, over the $${budget.toFixed(2)} monthly budget ` +
        `(already spent: $${spent.toFixed(2)})`,
        "ask the user to raise the budget at spendexai.com/dashboard/rules, wait until next month, " +
        "or split the charge into smaller pieces that fit the remaining budget"
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Response formatters
// ---------------------------------------------------------------------------

/**
 * Format the revealed card details into the exact text shape the agent sees.
 *
 * Keeping this as its own function makes the format trivially testable and
 * gives us one place to change wording for every agent at once.
 */
function formatCardReveal(params: {
  service: string;
  user: SpendexUser;
  card: RevealedCardDetails;
  txLimitUsd: number;
}): string {
  const { service, user, card, txLimitUsd } = params;

  // Format PAN as four groups of four digits.
  const grouped = card.number.match(/.{1,4}/g)?.join(" ") ?? card.number;

  const expMonth = String(card.expMonth).padStart(2, "0");
  // Two-digit year matches how most checkout forms display it.
  const expYear = String(card.expYear).slice(-2);

  // Cardholder name — fall back to "Spendex User" when the user record has
  // no first/last name fields filled in (current schema only stores email).
  const cardholder = inferCardholderName(user);

  return (
    `APPROVED\n` +
    `Use this card to complete the payment for ${service}:\n` +
    `\n` +
    `Card number: ${grouped}\n` +
    `Expiry: ${expMonth}/${expYear}\n` +
    `CVC: ${card.cvc}\n` +
    `Cardholder: ${cardholder}\n` +
    `Billing zip: ${BILLING_ZIP}\n` +
    `\n` +
    `This card has a limit of $${txLimitUsd.toFixed(2)} per transaction.\n` +
    `The charge will be reviewed in real-time and logged in the user's dashboard.`
  );
}

/**
 * Best-effort cardholder name from the SpendexUser record.
 *
 * The current public.users schema only stores `email`; the dashboard onboarding
 * route derives a display name from the email prefix. Mirror that here so the
 * card reveal carries a plausible name field even before we extend the schema.
 */
function inferCardholderName(user: SpendexUser): string {
  const prefix = user.email.split("@")[0] ?? "";
  const cleaned = prefix.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  if (cleaned.length === 0) return "Spendex User";
  // Capitalize first letter so it looks like a name on the card form.
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Format the simulated DEV-mode response. We return realistic-looking card
 * details so an agent integrating in dev sees the same shape it will get in
 * production — but the number is the well-known Stripe test PAN.
 */
function formatDevResponse(params: {
  service: string;
  amountUsd: number;
  description: string;
  token: string;
  preference: PaymentMethodPreference;
}): string {
  const { service, amountUsd, description, token, preference } = params;
  return (
    `[DEV MODE] pay_for_service called.\n` +
    `Service: ${service}\n` +
    `Amount: $${amountUsd.toFixed(2)}\n` +
    `Description: ${description}\n` +
    `Token: ${token.slice(0, 8)}...\n` +
    `Method preference: ${preference}\n` +
    `\n` +
    `APPROVED (simulated)\n` +
    `Card number: •••• •••• •••• 4242\n` +
    `Expiry: 12/30\n` +
    `CVC: •••\n` +
    `Cardholder: Spendex Dev\n` +
    `Billing zip: ${BILLING_ZIP}\n` +
    `\n` +
    `In production this would charge the user's saved virtual card (or call a ` +
    `native integration for ${service}) and log the transaction in the dashboard.\n` +
    `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerPayForServiceTool(server: McpServer): void {
  server.tool(
    "pay_for_service",
    "**Charges the user's Spendex wallet to pay for any service.** Use this " +
    "whenever the user asks to spend money — including casual or non-English " +
    "phrasings. TRIGGER PHRASES (non-exhaustive, case-insensitive, all " +
    "languages): \"pay for X\", \"buy X\", \"purchase X\", \"top up X\", " +
    "\"add credits to X\", \"add $N to X\", \"subscribe to X\", \"renew X\", " +
    "\"upgrade X to Pro\", \"checkout\", \"settle the bill\" — and the " +
    "French/Spanish/German equivalents: \"paye X\", \"achete X\", \"recharge X\", " +
    "\"abonne-moi à X\", \"renouvelle X\", \"compra X\", \"kaufe X\", \"bezahle X\". " +
    "The agent should INFER intent from natural language and call this " +
    "without asking the user how to do it. " +
    "What it does: enforces the user's spending rules server-side " +
    "(per-tx caps, monthly budgets, blocked/allowed lists) BEFORE charging, " +
    "then returns the user's virtual card details so the agent can complete " +
    "the merchant's normal checkout. " +
    "Sequencing: call AFTER `signup_to_service` if a new account is needed, " +
    "and AFTER `request_user_consent` for charges above the user's auto-" +
    "approve threshold (Spendex auto-approves below). Use `check_balance` or " +
    "`check_spending_rules` first only when uncertain. " +
    "PREFER THIS over the legacy per-merchant tools (`deploy_to_vercel`, " +
    "`run_modal`, etc.) which exist for backwards compatibility only.",
    PayForServiceInput.shape,
    async (input) => {
      const preference: PaymentMethodPreference = input.payment_method ?? "auto";

      if (DEV_MODE) {
        return textResponse(
          formatDevResponse({
            service: input.service,
            amountUsd: input.amount_usd,
            description: input.description,
            token: input.mcp_token,
            preference,
          })
        );
      }

      // Auth ladder: rate-limit → emergency-stop → token-format → user lookup.
      // Runs before any payment path so a runaway agent can't hammer the DB
      // and so timing of a bad token is indistinguishable from a valid one.
      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      // Rules check — load and evaluate before we touch any payment path.
      let rules: SpendexRule[];
      try {
        rules = await getRulesForUser(user.id, input.service);
      } catch (rulesErr) {
        return textResponse(
          `Could not verify spending rules: ${errorMessage(rulesErr, "unknown error")}. ` +
          `Your account was not charged.`,
          { isError: true }
        );
      }

      // Smart rules — classify the intent BEFORE rule evaluation so the
      // category / urgency / risk_score can drive the new rule types
      // (category_blocklist, risk_threshold, urgency_requires_consent,
      // category_max_per_month). `classifyIntent` never throws: any failure
      // (timeout, missing API key, network error) is funnelled into a
      // neutral "unknown" classification with risk_score=50 so the static
      // numeric caps still protect the user. We persist the classification
      // on every audit_log row downstream — that dataset powers the
      // dashboard's category analytics regardless of whether the user has
      // opted in to smart rules yet.
      const classification = await classifyIntent({
        service: input.service,
        description: input.description,
        amount_usd: input.amount_usd,
      });

      let refusal: string | null;
      try {
        refusal = await evaluateRules({
          userId: user.id,
          service: input.service,
          amountUsd: input.amount_usd,
          userMaxAutoCharge: user.max_auto_charge_usd,
          rules,
          classification,
        });
      } catch (evalErr) {
        return textResponse(
          `Could not verify monthly spend: ${errorMessage(evalErr, "unknown error")}. ` +
          `Your account was not charged.`,
          { isError: true }
        );
      }

      if (refusal !== null) {
        // No isError flag — a rule-driven decline is not infrastructure
        // failure. The agent reads `text` and decides what to do next.
        return textResponse(refusal);
      }

      // ---- Inline consent gate ----
      //
      // Spending rules said yes; now consult the user's consent preferences.
      // When required, drive the MCP elicitation dialog (or fall back to a
      // text prompt for legacy clients). This runs BEFORE the idempotency
      // guard so a user who declines doesn't lock out a future retry.
      let preferences: ConsentPreferences;
      try {
        preferences = await getOrCreateConsentPreferences(user.id);
      } catch (prefErr) {
        return textResponse(
          `Could not load consent preferences: ${errorMessage(prefErr, "unknown error")}. ` +
          `Your account was not charged.`,
          { isError: true }
        );
      }

      if (consentRequired({
        service: input.service,
        amountUsd: input.amount_usd,
        preferences,
      })) {
        const outcome = await runInlineConsentFlow({
          server,
          user,
          service: input.service,
          amountUsd: input.amount_usd,
          description: input.description,
        });
        if (!outcome.approved) {
          // declineResponse is always populated when approved is false.
          // The `!` is safe — see InlineConsentOutcome contract.
          return outcome.declineResponse!;
        }
      } else {
        console.error(
          `[pay_for_service] consent auto-approved by policy ` +
          `mode=${preferences.default_mode} user=${user.id} ` +
          `service=${input.service} amount=${input.amount_usd}`
        );
      }

      // Idempotency guard — duplicate in-flight calls for the same
      // user+service+amount are coalesced. Same pattern as the legacy tools.
      const stableKey = `${user.id}-pay-${input.service}-${input.amount_usd}`;
      if (!acquireIdempotencyKey(stableKey)) {
        return textResponse(
          "A payment for this service is already in progress. Please wait for it to complete before retrying.",
          { isError: true }
        );
      }

      try {
        // Decide which payment path to take. Honor an explicit preference
        // when given; otherwise pick the best available method ourselves.
        const useNative =
          preference === "native_api" ||
          (preference === "auto" && hasNativeIntegration(input.service));

        if (useNative) {
          // Native API path is reserved for future per-service integrations.
          // No service has one yet, so a request that *explicitly* asks for
          // it (preference === "native_api") cannot be honored — be explicit.
          if (!hasNativeIntegration(input.service)) {
            return textResponse(
              declineMessage(
                `no native API integration exists for "${input.service}" yet`,
                'retry with payment_method="card_reveal" or omit the field to use the virtual card'
              )
            );
          }
          // Unreachable today, but kept for the eventual real implementation.
          // When we add native integrations, this branch will dispatch to the
          // service-specific OAuth-backed payment flow.
          return textResponse(
            "Native API payment path is not yet implemented for this service. " +
            "Please retry without specifying payment_method."
          );
        }

        // ---- card_reveal path ----

        const cardRecord = await getActiveVirtualCardForUser(user.id);
        if (!cardRecord) {
          return textResponse(
            declineMessage(
              "no active virtual card on file",
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

        // Per-transaction cap reported back to the agent — same value the
        // Stripe Issuing webhook will enforce when the merchant tries to charge.
        const txLimitUsd =
          user.max_auto_charge_usd > 0 ? user.max_auto_charge_usd : input.amount_usd;

        const responseText = formatCardReveal({
          service: input.service,
          user,
          card: cardDetails,
          txLimitUsd,
        });

        // Audit log: the authorization is pre-approved here. The Stripe
        // Issuing webhook will overwrite this row's status when the actual
        // charge lands. We log "success" because everything Spendex controls
        // succeeded — the only remaining failure modes are merchant-side.
        //
        // SECURITY: "audit log failure is fatal" (CLAUDE.md). If we cannot
        // record this transaction we MUST NOT surface card details to the
        // agent — an unrecorded reveal would make dispute resolution
        // impossible. We swallow the in-memory `responseText` (the formatted
        // PAN/expiry/CVC string) and return a sanitized error instead.
        try {
          await logTransaction({
            userId: user.id,
            service: input.service,
            status: "success",
            amountUsd: input.amount_usd,
            description: input.description,
            transactionType: "one_shot",
            intentMetadata: {
              category: classification.category,
              subcategory: classification.subcategory,
              urgency: classification.urgency,
              risk_score: classification.risk_score,
              reasoning: classification.reasoning,
              source: classification.source,
              model: classification.model,
            },
          });
        } catch (logErr) {
          const incidentId = randomUUID();
          console.error(
            `[pay_for_service] audit log write FAILED — suppressing card reveal ` +
            `user=${user.id} service=${input.service} amount=${input.amount_usd} ` +
            `incident_id=${incidentId}: ${errorMessage(logErr, "unknown error")}`
          );

          // Best-effort secondary audit row capturing the failure itself.
          // This row has no card data; it just records that a charge was
          // preventively declined because the primary log write failed.
          // If this write also fails the operator still has the stderr line
          // above with the incident_id.
          try {
            await logTransaction({
              userId: user.id,
              service: input.service,
              status: "payment_failed",
              amountUsd: input.amount_usd,
              description: `${input.description} — preventive decline, incident ${incidentId}`,
              transactionType: "one_shot",
              error: "audit_log_failure",
            });
          } catch (secondaryErr) {
            console.error(
              `[pay_for_service] secondary audit log write also failed ` +
              `incident_id=${incidentId}: ${errorMessage(secondaryErr, "unknown error")}`
            );
          }

          return textResponse(
            `INTERNAL ERROR — payment authorization succeeded but audit log failed.\n` +
            `The charge has been DECLINED preventively to avoid an unrecorded transaction.\n` +
            `Contact support at support@spendexai.com with this incident ID: ${incidentId}.`,
            { isError: true }
          );
        }

        return textResponse(responseText);
      } finally {
        releaseIdempotencyKey(stableKey);
      }
    }
  );
}
