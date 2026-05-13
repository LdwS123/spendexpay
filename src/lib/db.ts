import { createHash, createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import type { PaymentMethod, ProviderCustomerId } from "./payments/types.js";
import { stripeCustomerId, stripeAchPaymentMethodId, payPalBillingAgreementId, circleWalletId } from "./payments/types.js";

// Lazy singleton — avoids URL validation error at startup in dev mode.
let _supabase: SupabaseClient | null = null;
export function getSupabase(): SupabaseClient {
  if (!_supabase) _supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey);
  return _supabase;
}
export const supabase = new Proxy({} as SupabaseClient, {
  get: (_t, prop) => getSupabase()[prop as keyof SupabaseClient],
});

/**
 * Hash a raw MCP token (e.g. "spx_…") with HMAC-SHA256 using MCP_TOKEN_SALT.
 *
 * The DB column `users.mcp_token` stores the hex digest, NEVER the raw token.
 * The dashboard that issues tokens uses the same salt so the hash matches at
 * lookup time. We use HMAC (not bare SHA256) so a stolen DB without the salt
 * cannot be used to verify guessed tokens via a rainbow-table attack.
 */
export function hashMcpToken(rawToken: string): string {
  return createHmac("sha256", config.mcp.tokenSalt).update(rawToken).digest("hex");
}

export interface SpendexUser {
  id: string;
  email: string;
  payment_method: PaymentMethod;
  // Branded per provider:
  //   stripe_card        → StripeCustomerId        ("cus_…")
  //   ach_bank_transfer  → StripeAchPaymentMethodId ("pm_…")
  //   paypal             → PayPalBillingAgreementId ("B-…")
  //   usdc_base          → CircleWalletId            (UUID)
  //   coinbase_commerce  → StripeCustomerId          (Coinbase wallet ref)
  //   apple_pay          → StripeCustomerId          ("cus_…")
  //   google_pay         → StripeCustomerId          ("cus_…")
  payment_provider_customer_id: ProviderCustomerId;
  vercel_token: string;
  netlify_token: string;
  railway_token: string;
  fly_token: string;
  replicate_token: string;
  render_token: string;
  modal_token: string;
  huggingface_token: string;
  gamma_api_key: string;
  cloudflare_token: string;
  cloudflare_account_id: string;
  supabase_user_token: string;
  max_auto_charge_usd: number; // 0 = always require confirmation
}

interface RawUserRow {
  id: string;
  email: string;
  payment_method: PaymentMethod;
  payment_provider_customer_id: string;
  vercel_token: string;
  netlify_token: string;
  railway_token: string;
  fly_token: string;
  replicate_token: string;
  render_token: string;
  modal_token: string;
  huggingface_token: string;
  gamma_api_key: string;
  cloudflare_token: string;
  cloudflare_account_id: string;
  supabase_user_token: string;
  max_auto_charge_usd: number;
}

// Single trust boundary where a plain DB string is stamped into the appropriate
// branded ID type. All downstream code then carries the correct brand without further casts.
function brandCustomerId(
  raw: string,
  method: PaymentMethod
): ProviderCustomerId {
  switch (method) {
    case "ach_bank_transfer":
      return stripeAchPaymentMethodId(raw);
    case "paypal":
      return payPalBillingAgreementId(raw);
    case "usdc_base":
      return circleWalletId(raw);
    case "stripe_card":
    case "apple_pay":
    case "google_pay":
    case "coinbase_commerce":
      return stripeCustomerId(raw);
  }
}

export async function getUserByCardholderId(cardholderId: string): Promise<SpendexUser | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, email, payment_method, payment_provider_customer_id, vercel_token, netlify_token, railway_token, fly_token, replicate_token, render_token, modal_token, huggingface_token, gamma_api_key, cloudflare_token, cloudflare_account_id, supabase_user_token, max_auto_charge_usd")
    .eq("stripe_cardholder_id", cardholderId)
    .single();

  if (error) {
    // PGRST116 = no row matched — cardholder ID not found in our DB.
    // Any other code is a real infrastructure problem that needs attention.
    if (error.code !== "PGRST116") {
      console.error(
        `[db] getUserByCardholderId: unexpected database error (code: ${error.code}): ${error.message}. ` +
        `Cardholder ID: ${cardholderId}. This may indicate a database outage or schema issue.`
      );
    }
    return null;
  }

  if (!data) return null;

  const row = data as RawUserRow;
  return {
    ...row,
    payment_provider_customer_id: brandCustomerId(
      row.payment_provider_customer_id,
      row.payment_method
    ),
  };
}

export async function getUserByMcpToken(token: string): Promise<SpendexUser | null> {
  // The raw token never leaves this function — we look up by its HMAC digest
  // so the DB never stores anything that could be replayed if leaked.
  const tokenHash = hashMcpToken(token);

  const { data, error } = await supabase
    .from("users")
    .select("id, email, payment_method, payment_provider_customer_id, vercel_token, netlify_token, railway_token, fly_token, replicate_token, render_token, modal_token, huggingface_token, gamma_api_key, cloudflare_token, cloudflare_account_id, supabase_user_token, max_auto_charge_usd")
    .eq("mcp_token", tokenHash)
    .single();

  if (error) {
    // PGRST116 = no row matched (invalid token) — return null silently.
    // Any other code is a real infrastructure problem; log it so it does not
    // look identical to a bad token from the outside.
    if (error.code !== "PGRST116") {
      console.error(
        `[db] getUserByMcpToken: unexpected database error (code: ${error.code}): ${error.message}. ` +
        `This is not a token validation failure — it may indicate a database outage or schema issue.`
      );
    }
    return null;
  }

  if (!data) return null;

  const row = data as RawUserRow;
  return {
    ...row,
    payment_provider_customer_id: brandCustomerId(
      row.payment_provider_customer_id,
      row.payment_method
    ),
  };
}

export async function updateAuditLogStatus(
  transactionId: string,
  status: string,
  extraData?: object
): Promise<void> {
  const patch: Record<string, unknown> = { status };

  // Serialize extra diagnostic data into error_message so it is visible in the
  // dashboard without a schema migration.
  if (extraData !== undefined) {
    patch["error_message"] = JSON.stringify(extraData);
  }

  const { error } = await supabase
    .from("audit_logs")
    .update(patch)
    .eq("transaction_id", transactionId);

  if (error) {
    // Throw so the webhook handler propagates the failure and Stripe retries.
    // A missed status update could leave a user charged without confirmation,
    // which is worse than Stripe retrying.
    console.error(
      `[db] updateAuditLogStatus: failed to update audit_log for ` +
      `transaction_id="${transactionId}" to status="${status}": ${error.message} (code: ${error.code}). ` +
      `Stripe will retry this webhook delivery.`
    );
    throw new Error(
      `Failed to update audit_log status for transaction "${transactionId}": ${error.message}`
    );
  }

  console.error(
    `[db] updateAuditLogStatus: audit_log row for transaction_id="${transactionId}" ` +
    `updated to status="${status}".`
  );
}

interface LogTransactionParams {
  userId: string;
  service: string;
  status: "success" | "payment_failed" | "deploy_failed_after_payment";
  amountUsd: number;
  description: string;
  // Provider-agnostic transaction ID (Stripe PaymentIntent ID, Coinbase charge ID, etc.)
  transactionId?: string;
  error?: string;
  // Optional classification fields — kept optional for backwards compat.
  transactionType?: string;
  agentId?: string;
  /**
   * LLM-classified intent metadata (category / urgency / risk_score / …)
   * captured at authorization time. Persisted on every row so the dashboard
   * and category-cap evaluator have a per-transaction view. Optional so
   * legacy callers (consent-pending audit rows, webhook updates) don't have
   * to populate it.
   */
  intentMetadata?: Record<string, unknown>;
}

interface LogIssuingAuthorizationParams {
  userId: string;
  authorizationId: string;
  cardId: string;
  amountUsd: number;
  merchant: string;
  approved: boolean;
  declineReason?: string;
}

/**
 * Write an issuing_authorization decision to the audit log.
 *
 * This is the record that a virtual card charge was approved or declined.
 * Called from the Stripe Issuing webhook handler — must be fast (we are in
 * the <2s authorization window). Uses a fire-and-forget pattern: write errors
 * are logged to stderr but never thrown, because the authorization decision
 * must always be returned to Stripe on time.
 */
export async function logIssuingAuthorization(
  params: LogIssuingAuthorizationParams
): Promise<void> {
  const { error } = await supabase.from("audit_logs").insert({
    user_id: params.userId,
    service: "stripe_issuing",
    status: params.approved ? "issuing_approved" : "issuing_declined",
    amount_usd: params.amountUsd,
    description: `Issuing authorization ${params.approved ? "approved" : "declined"} for ${params.merchant}`,
    transaction_id: params.authorizationId,
    error_message: params.declineReason ?? null,
    transaction_type: "issuing_authorization",
    agent_id: params.cardId,
    created_at: new Date().toISOString(),
  });

  if (error) {
    // Log but do not throw — the authorization decision has already been sent
    // to Stripe. A DB write failure here must not cause the webhook to retry
    // and re-run the authorization logic.
    console.error(
      `[db] logIssuingAuthorization: failed to write audit log for ` +
      `authorization_id="${params.authorizationId}" user=${params.userId} ` +
      `approved=${params.approved}: ${error.message} (code: ${error.code}). ` +
      `The authorization decision was already delivered to Stripe.`
    );
  }
}

// Append-only audit log; source of truth for dispute resolution.
//
// Error handling policy:
//   - "success" / "payment_failed": log the write failure to stderr but do not
//     throw — a logging failure must not crater a successful payment response.
//   - "deploy_failed_after_payment": this row is the ONLY record that a charge
//     was collected without service being delivered. Throw so the caller can
//     surface the transaction ID to the user and they can contact support.
export async function logTransaction(params: LogTransactionParams): Promise<void> {
  const { error } = await supabase.from("audit_logs").insert({
    user_id: params.userId,
    service: params.service,
    status: params.status,
    amount_usd: params.amountUsd,
    description: params.description,
    transaction_id: params.transactionId ?? null,
    error_message: params.error ?? null,
    transaction_type: params.transactionType ?? null,
    agent_id: params.agentId ?? null,
    intent_metadata: params.intentMetadata ?? null,
    created_at: new Date().toISOString(),
  });

  if (error) {
    const message =
      `[db] Failed to write audit log for user ${params.userId}, ` +
      `status "${params.status}", transactionId "${params.transactionId ?? "none"}": ${error.message}`;

    console.error(message);

    if (params.status === "deploy_failed_after_payment") {
      throw new Error(
        `CRITICAL: Payment was collected (transaction: ${params.transactionId ?? "unknown"}) ` +
        `but the audit log could not be written (${error.message}). ` +
        `This charge is NOT recorded in the audit trail. ` +
        `Contact support at spendexai.com/support with the transaction ID to request a refund.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Spending rules
//
// Users can configure rules in the dashboard to cap spending per service or
// across all services. The most common rule is a monthly budget — a single
// row with `service_filter = null` (all services) and a `monthly_budget_usd`
// value. Per-service rules use a non-null `service_filter` ("vercel",
// "modal", …) and are evaluated in addition to any global rule.
//
// All rule columns are nullable so that a row can express "only cap monthly
// spend" or "only cap per-transaction amount" without having to encode an
// unused limit as sentinel zeros.
// ---------------------------------------------------------------------------

export interface SpendexRule {
  id: string;
  user_id: string;
  /** Service this rule applies to, or null to apply to every service. */
  service_filter: string | null;
  /** Max USD this rule allows for a single transaction. null = no per-tx cap. */
  max_per_transaction_usd: number | null;
  /** Max USD this rule allows to be charged in a calendar month. null = no monthly cap. */
  monthly_budget_usd: number | null;
  /** Allow-list of service names. If non-null/non-empty, only these services are permitted. */
  allowed_services: string[] | null;
  /** Block-list of service names. Any service in this list is refused. */
  blocked_services: string[] | null;
  /**
   * Per-service monthly cap that targets this exact service (matched on the
   * `service` argument to `getRulesForUser`). Layered on top of any global
   * monthly_budget_usd — both are evaluated, the tighter one wins. null when
   * the user has no per-service monthly rule for this merchant.
   */
  per_service_monthly_cap_usd: number | null;
  /**
   * Per-service per-transaction cap that targets this exact service. Same
   * layering as above relative to the global `max_per_transaction_usd`.
   */
  per_service_per_tx_cap_usd: number | null;
  // ── Smart rules (migration 016) ───────────────────────────────────────
  // All four fields below are optional on the SpendexRule type so legacy
  // call sites (and the dozens of tests that construct synthetic rule rows)
  // keep compiling without listing every smart-rule field. The runtime
  // evaluator treats `undefined` and `null` the same way.
  /**
   * Categories the user has explicitly blocked (e.g. "gambling", "crypto").
   * Evaluated against the LLM-classified intent category, NOT the service
   * name. null/undefined when the user has no category blocklist configured.
   */
  category_blocklist?: string[] | null;
  /**
   * Per-category monthly caps (e.g. {"shopping": 200, "dev_tools": 500}).
   * Cumulated against successful audit_logs.intent_metadata->category for
   * the calendar month. null/undefined when no category caps exist.
   */
  category_caps?: Record<string, number> | null;
  /**
   * Maximum LLM risk score (0-100) the user is willing to auto-approve.
   * A classification with `risk_score > risk_threshold` is declined.
   * null/undefined when no risk threshold rule exists.
   */
  risk_threshold?: number | null;
  /**
   * When true, any classification with `urgency = "high"` requires explicit
   * consent — the tool declines and asks the agent to call
   * request_user_consent first. Defaults to false.
   */
  urgency_requires_consent?: boolean;
  /** Soft-delete / pause flag. */
  active: boolean;
}

interface RawJsonbRuleRow {
  id: string;
  user_id: string;
  rule_type: string;
  params: Record<string, unknown> | null;
  active: boolean;
}

/**
 * Fetch all active spending rules for a user that apply to the given service.
 * The rules table stores JSONB `params` keyed by `rule_type` — this function
 * normalizes them into a single `SpendexRule` shape callers can evaluate.
 */
export async function getRulesForUser(
  userId: string,
  service: string
): Promise<SpendexRule[]> {
  const { data, error } = await supabase
    .from("rules")
    .select("id, user_id, rule_type, params, active")
    .eq("user_id", userId)
    .eq("active", true);

  if (error) {
    console.error(
      `[db] getRulesForUser: failed to fetch rules for user ${userId}: ${error.message} (code: ${error.code}).`
    );
    throw new Error(
      `Could not load spending rules (${error.message}). The charge was not attempted.`
    );
  }

  const rows = (data ?? []) as RawJsonbRuleRow[];
  if (rows.length === 0) return [];

  // Collapse all jsonb rules into a single synthetic SpendexRule per user
  // (the consumers in pay-for-service / request-consent only inspect the
  // aggregated caps, not per-row metadata).
  let maxPerTx: number | null = null;
  let monthlyBudget: number | null = null;
  let allowed: string[] | null = null;
  let blocked: string[] | null = null;
  let perServiceMonthlyCap: number | null = null;
  let perServicePerTxCap: number | null = null;
  // A per_service rule with `blocked: true` is treated as adding the service
  // to the blocked_services list for this evaluation. The dashboard surfaces
  // it as a dedicated per-service toggle so users can manage everything in
  // one place rather than juggling a separate global block list.
  const perServiceBlocked: string[] = [];

  // Smart rules (migration 016) — populated when the user has opted in.
  let categoryBlocklist: string[] | null = null;
  let categoryCaps: Record<string, number> | null = null;
  let riskThreshold: number | null = null;
  let urgencyRequiresConsent = false;

  const normalizedTargetService = service.toLowerCase();

  for (const row of rows) {
    const params = row.params ?? {};
    if (row.rule_type === "max_amount_per_tx" && typeof params.usd === "number") {
      maxPerTx = params.usd;
    } else if (row.rule_type === "max_amount_per_month" && typeof params.usd === "number") {
      monthlyBudget = params.usd;
    } else if (row.rule_type === "allowed_services" && Array.isArray(params.services)) {
      allowed = params.services.filter((s): s is string => typeof s === "string");
    } else if (row.rule_type === "blocked_services" && Array.isArray(params.services)) {
      blocked = params.services.filter((s): s is string => typeof s === "string");
    } else if (
      row.rule_type === "per_service_monthly_cap" &&
      typeof params.service === "string"
    ) {
      if (params.service.toLowerCase() !== normalizedTargetService) continue;
      if (params.blocked === true) {
        perServiceBlocked.push(params.service);
      }
      if (typeof params.monthly_cap_usd === "number") {
        // Tighter wins when the user somehow has more than one row.
        if (
          perServiceMonthlyCap === null ||
          params.monthly_cap_usd < perServiceMonthlyCap
        ) {
          perServiceMonthlyCap = params.monthly_cap_usd;
        }
      }
    } else if (
      row.rule_type === "per_service_per_tx_cap" &&
      typeof params.service === "string"
    ) {
      if (params.service.toLowerCase() !== normalizedTargetService) continue;
      if (params.blocked === true) {
        perServiceBlocked.push(params.service);
      }
      if (typeof params.per_tx_cap_usd === "number") {
        if (
          perServicePerTxCap === null ||
          params.per_tx_cap_usd < perServicePerTxCap
        ) {
          perServicePerTxCap = params.per_tx_cap_usd;
        }
      }
    } else if (
      row.rule_type === "category_blocklist" &&
      Array.isArray(params.categories)
    ) {
      const cats = params.categories.filter(
        (c): c is string => typeof c === "string" && c.length > 0
      );
      categoryBlocklist = [...(categoryBlocklist ?? []), ...cats];
    } else if (
      row.rule_type === "category_max_per_month" &&
      typeof params.category === "string" &&
      typeof params.usd === "number"
    ) {
      // Tighter wins when the user has more than one row for the same
      // category (legacy / drift). Stored lower-cased so lookups match the
      // classification output (which we also lower-case).
      const key = params.category.toLowerCase();
      if (categoryCaps === null) categoryCaps = {};
      const prev = categoryCaps[key];
      if (prev === undefined || params.usd < prev) {
        categoryCaps[key] = params.usd;
      }
    } else if (
      row.rule_type === "risk_threshold" &&
      typeof params.threshold === "number"
    ) {
      const clamped = Math.max(0, Math.min(100, Math.round(params.threshold)));
      // Tighter wins.
      if (riskThreshold === null || clamped < riskThreshold) {
        riskThreshold = clamped;
      }
    } else if (
      row.rule_type === "urgency_requires_consent" &&
      params.enabled === true
    ) {
      urgencyRequiresConsent = true;
    }
  }

  // Merge per-service blocks into the global blocked_services list so the
  // existing evaluator (which only looks at `blocked_services`) keeps
  // working without a second code path.
  if (perServiceBlocked.length > 0) {
    blocked = [...(blocked ?? []), ...perServiceBlocked];
  }

  return [{
    id: rows[0].id,
    user_id: userId,
    service_filter: null,
    max_per_transaction_usd: maxPerTx,
    monthly_budget_usd: monthlyBudget,
    allowed_services: allowed,
    blocked_services: blocked,
    per_service_monthly_cap_usd: perServiceMonthlyCap,
    per_service_per_tx_cap_usd: perServicePerTxCap,
    category_blocklist: categoryBlocklist,
    category_caps: categoryCaps,
    risk_threshold: riskThreshold,
    urgency_requires_consent: urgencyRequiresConsent,
    active: true,
  }];
}

/**
 * Sum the USD amount of every successful audit_log row for this user
 * (optionally filtered to one service) in the current calendar month, UTC.
 *
 * Used to enforce monthly budgets before authorizing a new charge.
 */
export async function getMonthlySpendUsd(
  userId: string,
  service?: string
): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  let query = supabase
    .from("audit_logs")
    .select("amount_usd")
    .eq("user_id", userId)
    .eq("status", "success")
    .gte("created_at", monthStart);

  if (service !== undefined) {
    query = query.eq("service", service);
  }

  const { data, error } = await query;

  if (error) {
    console.error(
      `[db] getMonthlySpendUsd: failed for user ${userId}` +
      (service ? ` service "${service}"` : "") +
      `: ${error.message} (code: ${error.code}).`
    );
    throw new Error(
      `Could not compute monthly spend (${error.message}). The charge was not attempted.`
    );
  }

  const rows = (data ?? []) as Array<{ amount_usd: number | null }>;
  return rows.reduce<number>((sum, row) => sum + (row.amount_usd ?? 0), 0);
}

/**
 * Convenience wrapper for `getMonthlySpendUsd(userId, service)` that makes
 * call sites explicit when they are asking specifically about per-service
 * spend (as opposed to "all services" which would pass undefined).
 *
 * Implemented in terms of `getMonthlySpendUsd` so we have one place that
 * defines the SQL filter and "calendar month UTC" semantics.
 */
export async function getMonthlySpendUsdForService(
  userId: string,
  service: string
): Promise<number> {
  return getMonthlySpendUsd(userId, service);
}

/**
 * Sum successful spend for a given LLM-classified category in the current
 * calendar month. Filters audit_logs on `intent_metadata->>'category' = X`
 * — the column is JSONB so we use the `->>'category'` text accessor for the
 * equality match. Rows without intent_metadata simply do not match.
 *
 * Used by the smart-rules engine when a `category_max_per_month` rule is
 * active. Returns 0 if no matching rows or on any DB error (best-effort: a
 * monthly-cap evaluator must not block a charge when the read fails — the
 * caller wraps this in a try/catch and surfaces a clear infrastructure
 * error instead).
 */
export async function getMonthlyCategorySpendUsd(
  userId: string,
  category: string
): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const { data, error } = await supabase
    .from("audit_logs")
    .select("amount_usd")
    .eq("user_id", userId)
    .eq("status", "success")
    .gte("created_at", monthStart)
    // PostgREST exposes JSONB field-as-text via `->>` syntax. The column was
    // added in migration 016; legacy rows (intent_metadata = null) simply
    // don't match.
    .eq("intent_metadata->>category", category);

  if (error) {
    console.error(
      `[db] getMonthlyCategorySpendUsd: failed for user ${userId} ` +
      `category "${category}": ${error.message} (code: ${error.code}).`
    );
    throw new Error(
      `Could not compute monthly category spend (${error.message}). The charge was not attempted.`
    );
  }

  const rows = (data ?? []) as Array<{ amount_usd: number | null }>;
  return rows.reduce<number>((sum, row) => sum + (row.amount_usd ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Virtual cards
//
// Each user gets one active virtual card issued via Stripe Issuing. The row
// in `virtual_cards` stores the Stripe-side card identifier; sensitive card
// data (PAN, CVC) is never persisted — it is fetched on demand from Stripe
// via `stripe.issuing.cards.retrieve(id, { expand: ['number', 'cvc'] })`.
// ---------------------------------------------------------------------------

export interface VirtualCardRecord {
  stripe_card_id: string;
}

// ---------------------------------------------------------------------------
// Managed accounts
//
// When an agent uses Spendex's auto-signup flow, we generate an email alias
// and password and persist the (encrypted) credentials in `managed_accounts`.
// Status lifecycle (matches migrations/002_managed_accounts.sql):
//   'pending'   row created, agent has the credentials in-flight
//      → 'active'   agent confirmed the account exists via complete_signup
//      → 'disabled' manually deactivated by support/user
//      → 'revoked'  downstream service kicked us out (account banned/closed)
//
// The password column stores the AES-256-GCM blob from src/lib/crypto.ts.
// We never log the plaintext password and never return it after the
// signup_to_service response that originally produced it.
//
// (user_id, service) is UNIQUE — a re-signup for the same service surfaces
// as a 23505 unique-constraint violation, which `createManagedAccount`
// translates into a clear error.
// ---------------------------------------------------------------------------

export type ManagedAccountStatus = "pending" | "active" | "disabled" | "revoked";

export interface ManagedAccountRecord {
  id: string;
  user_id: string;
  service: string;
  email_alias: string;
  password_encrypted: string;
  status: ManagedAccountStatus;
  external_account_id: string | null;
  created_at: string;
}

interface CreateManagedAccountParams {
  userId: string;
  service: string;
  emailAlias: string;
  passwordEncrypted: string;
}

/**
 * Insert a new managed_accounts row in status='pending'.
 *
 * Returns the generated UUID so the agent can reference this row in later
 * tool calls (get_verification_email, complete_signup). Throws on insert
 * failure — the signup tool surfaces that as an infrastructure error rather
 * than handing the agent half-provisioned credentials.
 */
export async function createManagedAccount(
  params: CreateManagedAccountParams
): Promise<ManagedAccountRecord> {
  const { data, error } = await supabase
    .from("managed_accounts")
    .insert({
      user_id: params.userId,
      service: params.service,
      email_alias: params.emailAlias,
      password_encrypted: params.passwordEncrypted,
      status: "pending" satisfies ManagedAccountStatus,
    })
    .select("id, user_id, service, email_alias, password_encrypted, status, external_account_id, created_at")
    .single();

  if (error || !data) {
    const message = error?.message ?? "no row returned from insert";
    console.error(
      `[db] createManagedAccount: failed to insert for user ${params.userId} ` +
      `service "${params.service}": ${message}`
    );
    // 23505 = unique_violation. The schema has UNIQUE (user_id, service) so
    // a duplicate signup for the same service throws here. Surface a
    // dedicated message so the tool can tell the agent to call
    // get_managed_account instead of issuing another set of credentials.
    if (error?.code === "23505") {
      throw new Error(
        `A managed account for service "${params.service}" already exists for this user.`
      );
    }
    throw new Error(`Failed to create managed account record: ${message}`);
  }

  return data as ManagedAccountRecord;
}

/**
 * Fetch a managed_accounts row and verify it belongs to the calling user.
 *
 * Returns null if the row does not exist OR if it exists but belongs to a
 * different user — the two cases are indistinguishable from the caller's
 * perspective, which is intentional (prevents probing for which IDs exist).
 */
export async function getManagedAccount(
  id: string,
  userId: string
): Promise<ManagedAccountRecord | null> {
  const { data, error } = await supabase
    .from("managed_accounts")
    .select("id, user_id, service, email_alias, password_encrypted, status, external_account_id, created_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (error.code !== "PGRST116") {
      console.error(
        `[db] getManagedAccount: unexpected error (code: ${error.code}): ${error.message}. ` +
        `id=${id} user=${userId}`
      );
    }
    return null;
  }
  if (!data) return null;
  return data as ManagedAccountRecord;
}

/**
 * Fetch the most recent managed_accounts row for (user, service).
 *
 * Returns null when the user has no managed account for that service. Used by
 * merchant-specific checkout helpers (e.g. `prepare_amazon_checkout`) that
 * need to surface the Spendex-managed login credentials so the agent can sign
 * in to the merchant's site before driving Computer Use. The decryption of
 * `password_encrypted` is the caller's responsibility — this helper only
 * returns the encrypted blob.
 */
export async function getManagedAccountByService(
  userId: string,
  service: string
): Promise<ManagedAccountRecord | null> {
  const { data, error } = await supabase
    .from("managed_accounts")
    .select("id, user_id, service, email_alias, password_encrypted, status, external_account_id, created_at")
    .eq("user_id", userId)
    .eq("service", service)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (error.code !== "PGRST116") {
      console.error(
        `[db] getManagedAccountByService: unexpected error (code: ${error.code}): ${error.message}. ` +
        `user=${userId} service=${service}`
      );
    }
    return null;
  }
  if (!data) return null;
  return data as ManagedAccountRecord;
}

/**
 * Update a managed account's status (and optionally store the external ID
 * the merchant assigned to the new account).
 *
 * Used by `complete_signup` to mark a row as 'active' once the agent confirms
 * the signup landed at the merchant.
 */
export async function updateManagedAccountStatus(
  id: string,
  status: ManagedAccountStatus,
  externalAccountId?: string
): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (externalAccountId !== undefined) {
    patch["external_account_id"] = externalAccountId;
  }

  const { error } = await supabase
    .from("managed_accounts")
    .update(patch)
    .eq("id", id);

  if (error) {
    console.error(
      `[db] updateManagedAccountStatus: failed to update id=${id} ` +
      `to status="${status}": ${error.message} (code: ${error.code}).`
    );
    throw new Error(`Failed to update managed account status: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Inbound emails
//
// The address `*@mail.spendexai.com` is bound to an SES/Postmark inbound
// route that POSTs to dashboard/src/app/api/webhooks/email-inbound, which
// writes one row per delivery. The `get_verification_email` tool polls this
// table for messages addressed to the alias we generated for a managed
// account.
//
// `verification_link` and `verification_code` are best-effort extractions
// done by the webhook handler — when populated they let the agent skip
// re-parsing body_text.
// ---------------------------------------------------------------------------

export interface InboundEmailRecord {
  id: string;
  email_alias: string;
  managed_account_id: string;
  from_address: string;
  subject: string;
  body_text: string;
  verification_link: string | null;
  verification_code: string | null;
  received_at: string;
}

interface RawInboundEmailRow {
  id: string;
  email_alias: string;
  managed_account_id: string;
  from_address: string;
  subject: string | null;
  body_text: string | null;
  verification_link: string | null;
  verification_code: string | null;
  received_at: string;
}

/**
 * Fetch the most recent inbound email for the given alias, received at or
 * after `sinceIso`. Returns null when no message has landed yet.
 *
 * Used by the verification-email polling loop. The caller is expected to call
 * this every couple of seconds until either a row appears or its overall
 * deadline expires.
 */
export async function getLatestInboundEmail(
  emailAlias: string,
  sinceIso: string
): Promise<InboundEmailRecord | null> {
  const { data, error } = await supabase
    .from("inbound_emails")
    .select(
      "id, email_alias, managed_account_id, from_address, subject, body_text, " +
      "verification_link, verification_code, received_at"
    )
    .eq("email_alias", emailAlias)
    .gte("received_at", sinceIso)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (error.code !== "PGRST116") {
      console.error(
        `[db] getLatestInboundEmail: unexpected error (code: ${error.code}): ${error.message}. ` +
        `alias="${emailAlias}"`
      );
    }
    return null;
  }

  if (!data) return null;

  // Supabase's typed client returns a generic string-error stub when it can't
  // resolve the schema at compile time. Route through `unknown` so we don't
  // accidentally silence a legitimate shape mismatch elsewhere.
  const row = data as unknown as RawInboundEmailRow;
  return {
    id: row.id,
    email_alias: row.email_alias,
    managed_account_id: row.managed_account_id,
    from_address: row.from_address,
    subject: row.subject ?? "",
    body_text: row.body_text ?? "",
    verification_link: row.verification_link,
    verification_code: row.verification_code,
    received_at: row.received_at,
  };
}

// ---------------------------------------------------------------------------
// Auto-signup authorization flag
//
// Surfaced as a column on the rules row. A user opts in to letting Spendex
// create accounts on their behalf by setting `allow_auto_signup = true`. The
// field is tri-valued by intention:
//   - true   → explicitly opted in
//   - false  → explicitly opted out (decline with a clear message)
//   - null   → never configured (treated as "opted in" today, but we keep the
//              column nullable so a future UI default flip is one SQL UPDATE
//              away from changing the policy without a code change).
// ---------------------------------------------------------------------------

/**
 * Read the `allow_auto_signup` flag from the user's rules row(s).
 *
 * Returns `false` only when a rule explicitly sets the flag to `false`.
 * Returns `true` when at least one rule sets it to `true`, and `null` if no
 * rule mentions it. Callers (the signup tool) decide what `null` means in
 * their context.
 */
export async function getAutoSignupAllowance(
  userId: string
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("rules")
    .select("allow_auto_signup")
    .eq("user_id", userId)
    .eq("active", true);

  if (error) {
    console.error(
      `[db] getAutoSignupAllowance: failed for user ${userId}: ` +
      `${error.message} (code: ${error.code}).`
    );
    throw new Error(`Could not load auto-signup permission: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{ allow_auto_signup: boolean | null }>;
  if (rows.length === 0) return null;

  // An explicit `false` anywhere wins — opt-out is the strongest signal.
  if (rows.some((r) => r.allow_auto_signup === false)) return false;
  if (rows.some((r) => r.allow_auto_signup === true)) return true;
  return null;
}

/**
 * Fetch the user's active virtual card identifier.
 *
 * Returns null if the user has no card on file or the row could not be read.
 * Returning null (instead of throwing) lets the caller surface a clean
 * "no card on file" message to the agent rather than a stack trace.
 */
export async function getActiveVirtualCardForUser(
  userId: string
): Promise<VirtualCardRecord | null> {
  const { data, error } = await supabase
    .from("virtual_cards")
    .select("stripe_card_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(
      `[db] getActiveVirtualCardForUser: failed to query virtual_cards for ` +
      `user ${userId}: ${error.message} (code: ${error.code}).`
    );
    return null;
  }

  if (!data) return null;
  return data as VirtualCardRecord;
}

// ---------------------------------------------------------------------------
// Product preview cache
//
// `fetch_product_preview` writes one row per successful scrape — whether the
// data came from our own server-side fetch or from the host agent's browser
// tool (when the merchant blocks bots). Subsequent calls for the same URL
// reuse the cached row until `ttl_expires_at` passes.
//
// See migrations/009_product_previews_cache.sql for the schema. The
// `url_hash` column is a hex SHA-256 of the canonical URL (toString()) so
// we can build a small, well-typed index.
// ---------------------------------------------------------------------------

export type ProductPreviewSource = "server_fetch" | "agent_extracted";

export interface ProductPreviewRow {
  url: string;
  title: string | null;
  image_url: string | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  site_name: string | null;
  source: ProductPreviewSource;
  created_at: string;
  ttl_expires_at: string;
}

interface RawProductPreviewRow {
  url: string;
  title: string | null;
  image_url: string | null;
  description: string | null;
  price: number | string | null;
  currency: string | null;
  site_name: string | null;
  source: ProductPreviewSource;
  created_at: string;
  ttl_expires_at: string;
}

/**
 * Hash a URL for the `url_hash` column. Plain SHA-256 (not HMAC) is fine
 * here because the value is not security-sensitive — we just need a stable,
 * fixed-width key for indexing. Two different processes hashing the same
 * URL must produce the same digest, which rules out HMAC with a salt.
 */
export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * Look up the freshest non-expired cached preview for a URL. Returns null
 * when no row exists or the most recent one has expired.
 *
 * Filtering on `ttl_expires_at > now()` in SQL means the index sweep skips
 * stale rows entirely — we never see them in application code, which makes
 * "cache expired → re-fetch" automatic without an eviction job.
 */
export async function getCachedProductPreview(
  url: string
): Promise<ProductPreviewRow | null> {
  const urlHash = hashUrl(url);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("product_previews")
    .select(
      "url, title, image_url, description, price, currency, site_name, " +
      "source, created_at, ttl_expires_at"
    )
    .eq("url_hash", urlHash)
    .gt("ttl_expires_at", nowIso)
    .order("ttl_expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (error.code !== "PGRST116") {
      console.error(
        `[db] getCachedProductPreview: unexpected error (code: ${error.code}): ` +
        `${error.message}. url_hash=${urlHash}`
      );
    }
    return null;
  }

  if (!data) return null;

  const row = data as unknown as RawProductPreviewRow;
  return {
    url: row.url,
    title: row.title,
    image_url: row.image_url,
    description: row.description,
    // Supabase returns numeric columns as strings to preserve precision; coerce
    // back to number for downstream consumers.
    price: row.price === null ? null : Number(row.price),
    currency: row.currency,
    site_name: row.site_name,
    source: row.source,
    created_at: row.created_at,
    ttl_expires_at: row.ttl_expires_at,
  };
}

interface CacheProductPreviewParams {
  url: string;
  title: string | null;
  imageUrl: string | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  siteName: string | null;
  source: ProductPreviewSource;
}

/**
 * Insert one row into product_previews. Best-effort: a failure here does
 * not invalidate the preview we already extracted, so we log the error and
 * return rather than throw. The next call for the same URL will just miss
 * the cache and re-scrape.
 */
export async function cacheProductPreview(
  params: CacheProductPreviewParams
): Promise<void> {
  const urlHash = hashUrl(params.url);
  const { error } = await supabase.from("product_previews").insert({
    url: params.url,
    url_hash: urlHash,
    title: params.title,
    image_url: params.imageUrl,
    description: params.description,
    price: params.price,
    currency: params.currency,
    site_name: params.siteName,
    source: params.source,
  });

  if (error) {
    console.error(
      `[db] cacheProductPreview: failed to insert for url="${params.url}" ` +
      `source=${params.source}: ${error.message} (code: ${error.code}).`
    );
  }
}

// ---------------------------------------------------------------------------
// Product variants cache
//
// `get_product_variants` writes one row per successful parse — either the
// server-side JSON-LD scrape worked, or the host agent's browser tool
// extracted the variant tree after we returned a SCRAPING BLOCKED
// instruction. Either way the row is reused for 7 days. See
// migrations/014_product_variants_cache.sql for the schema.
//
// The TypeScript shape of `variants` is a discriminated array of axis
// options — color/size/storage/etc. — each carrying an optional price
// delta and image URL. We persist the array as JSONB rather than
// normalising into a child table because the shape is genuinely
// heterogeneous across merchants and a join would add cost without
// adding safety.
// ---------------------------------------------------------------------------

export type ProductVariantsSource = "server_fetch" | "agent_extracted";

/**
 * One selectable option on a single variant axis. `axis` is the human
 * label of the axis ("color", "size", "storage"); `name` is the
 * display name of this option ("Midnight Blue"); `value` is the
 * machine-friendly identifier the merchant uses internally ("blue-256gb").
 *
 * `price_delta_usd` is the increment in USD that picking this option
 * adds on top of `base_price_usd`. 0 (or undefined) means the option
 * doesn't change the price.
 */
export interface ProductVariantOption {
  axis: string;
  name: string;
  value: string;
  price_delta_usd?: number;
  available: boolean;
  image_url?: string;
}

export interface ProductVariantsRow {
  url: string;
  variants: ProductVariantOption[];
  base_price_usd: number | null;
  currency: string | null;
  min_quantity: number;
  max_quantity: number;
  source: ProductVariantsSource;
  created_at: string;
  ttl_expires_at: string;
}

interface RawProductVariantsRow {
  url: string;
  variants: unknown;
  base_price_usd: number | string | null;
  currency: string | null;
  min_quantity: number | null;
  max_quantity: number | null;
  source: ProductVariantsSource;
  created_at: string;
  ttl_expires_at: string;
}

/**
 * Validate an unknown value (typically a JSONB column straight from
 * Postgres) into a typed `ProductVariantOption[]`. We don't trust the
 * DB blindly — a row written by an older code path could carry an
 * unexpected shape, and the row format is part of the public agent
 * contract, so we'd rather drop a malformed entry than silently surface
 * it. Returns an empty array when the input is not an array.
 */
function coerceVariantOptions(value: unknown): ProductVariantOption[] {
  if (!Array.isArray(value)) return [];
  const out: ProductVariantOption[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const axis = typeof rec.axis === "string" ? rec.axis : null;
    const name = typeof rec.name === "string" ? rec.name : null;
    const variantValue = typeof rec.value === "string" ? rec.value : null;
    const available = typeof rec.available === "boolean" ? rec.available : true;
    if (!axis || !name || !variantValue) continue;
    const option: ProductVariantOption = {
      axis,
      name,
      value: variantValue,
      available,
    };
    if (typeof rec.price_delta_usd === "number" && Number.isFinite(rec.price_delta_usd)) {
      option.price_delta_usd = rec.price_delta_usd;
    }
    if (typeof rec.image_url === "string" && rec.image_url.length > 0) {
      option.image_url = rec.image_url;
    }
    out.push(option);
  }
  return out;
}

/**
 * Look up the freshest non-expired cached variants row for a URL. Same
 * design as `getCachedProductPreview` — filter on `ttl_expires_at >
 * now()` so the index sweep skips stale rows, and return null when
 * nothing matches.
 */
export async function getCachedVariants(
  url: string
): Promise<ProductVariantsRow | null> {
  const urlHash = hashUrl(url);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("product_variants")
    .select(
      "url, variants, base_price_usd, currency, min_quantity, max_quantity, " +
      "source, created_at, ttl_expires_at"
    )
    .eq("url_hash", urlHash)
    .gt("ttl_expires_at", nowIso)
    .order("ttl_expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (error.code !== "PGRST116") {
      console.error(
        `[db] getCachedVariants: unexpected error (code: ${error.code}): ` +
        `${error.message}. url_hash=${urlHash}`
      );
    }
    return null;
  }

  if (!data) return null;

  const row = data as unknown as RawProductVariantsRow;
  return {
    url: row.url,
    variants: coerceVariantOptions(row.variants),
    base_price_usd:
      row.base_price_usd === null ? null : Number(row.base_price_usd),
    currency: row.currency,
    min_quantity: row.min_quantity ?? 1,
    max_quantity: row.max_quantity ?? 99,
    source: row.source,
    created_at: row.created_at,
    ttl_expires_at: row.ttl_expires_at,
  };
}

interface CacheVariantsParams {
  url: string;
  variants: ProductVariantOption[];
  basePriceUsd: number | null;
  currency: string | null;
  minQuantity: number;
  maxQuantity: number;
}

/**
 * Insert one row into product_variants. Best-effort: a failure here
 * does not invalidate the variant data we already extracted, so we log
 * and return rather than throw. The next call for the same URL will
 * miss the cache and re-parse.
 */
export async function cacheVariants(
  params: CacheVariantsParams,
  source: ProductVariantsSource
): Promise<void> {
  const urlHash = hashUrl(params.url);
  const { error } = await supabase.from("product_variants").insert({
    url: params.url,
    url_hash: urlHash,
    variants: params.variants,
    base_price_usd: params.basePriceUsd,
    currency: params.currency,
    min_quantity: params.minQuantity,
    max_quantity: params.maxQuantity,
    source,
  });

  if (error) {
    console.error(
      `[db] cacheVariants: failed to insert for url="${params.url}" ` +
      `source=${source}: ${error.message} (code: ${error.code}).`
    );
  }
}

// ---------------------------------------------------------------------------
// Consent layer
//
// Two tables back the "agent asks the user before acting" flow (see
// migrations/003_consent_layer.sql):
//
//   user_consent_preferences — per-user policy (always_ask, threshold, …)
//   consent_requests         — one row per prompt sent to the user
//
// The MCP server uses the service-role key, so RLS is bypassed; ownership is
// enforced explicitly here. Helpers below all return null (rather than
// throwing) for "not found / not yours" cases to keep callers terse.
// ---------------------------------------------------------------------------

export type ConsentDefaultMode =
  | "always_ask"
  | "auto_below_threshold"
  | "auto_for_trusted_services"
  | "never_auto";

export type ConsentStatus = "pending" | "approved" | "declined" | "expired";

export interface ConsentPreferences {
  user_id: string;
  default_mode: ConsentDefaultMode;
  auto_below_threshold_usd: number | null;
  trusted_services: string[];
  notification_channels: string[];
  telegram_chat_id: string | null;
  email_for_consent: string | null;
}

interface RawConsentPreferencesRow {
  user_id: string;
  default_mode: ConsentDefaultMode;
  auto_below_threshold_usd: number | null;
  trusted_services: unknown;
  notification_channels: unknown;
  telegram_chat_id: string | null;
  email_for_consent: string | null;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

function mapConsentPreferencesRow(row: RawConsentPreferencesRow): ConsentPreferences {
  return {
    user_id: row.user_id,
    default_mode: row.default_mode,
    auto_below_threshold_usd: row.auto_below_threshold_usd,
    trusted_services: coerceStringArray(row.trusted_services),
    notification_channels: coerceStringArray(row.notification_channels),
    telegram_chat_id: row.telegram_chat_id,
    email_for_consent: row.email_for_consent,
  };
}

/**
 * Fetch the user's consent preferences, creating a row with defaults the
 * first time it is requested.
 *
 * The defaults mirror the column defaults in
 * migrations/003_consent_layer.sql so a freshly inserted row and a
 * fall-through "no row yet" both behave identically.
 *
 * We do not throw if the upsert fails to read back — instead we synthesise
 * the default object and return it. The MCP tool that called us can still
 * make its decision (always_ask is the safest default) and the next call
 * will retry the upsert.
 */
export async function getOrCreateConsentPreferences(
  userId: string
): Promise<ConsentPreferences> {
  // First try a plain select — the row exists for every user except on
  // their very first consent prompt.
  const existing = await supabase
    .from("user_consent_preferences")
    .select(
      "user_id, default_mode, auto_below_threshold_usd, trusted_services, " +
      "notification_channels, telegram_chat_id, email_for_consent"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error && existing.error.code !== "PGRST116") {
    console.error(
      `[db] getOrCreateConsentPreferences: unexpected error reading row for ` +
      `user ${userId}: ${existing.error.message} (code: ${existing.error.code}).`
    );
  }

  if (existing.data) {
    return mapConsentPreferencesRow(
      existing.data as unknown as RawConsentPreferencesRow
    );
  }

  // No row yet — insert defaults. We do not use upsert here so that a race
  // with another concurrent call surfaces a 23505 we can swallow.
  const insertResult = await supabase
    .from("user_consent_preferences")
    .insert({ user_id: userId })
    .select(
      "user_id, default_mode, auto_below_threshold_usd, trusted_services, " +
      "notification_channels, telegram_chat_id, email_for_consent"
    )
    .single();

  if (insertResult.error) {
    if (insertResult.error.code === "23505") {
      // Race: another call inserted the row between our select and insert.
      // Re-read it and return.
      const reread = await supabase
        .from("user_consent_preferences")
        .select(
          "user_id, default_mode, auto_below_threshold_usd, trusted_services, " +
          "notification_channels, telegram_chat_id, email_for_consent"
        )
        .eq("user_id", userId)
        .maybeSingle();
      if (reread.data) {
        return mapConsentPreferencesRow(
          reread.data as unknown as RawConsentPreferencesRow
        );
      }
    }
    console.error(
      `[db] getOrCreateConsentPreferences: insert failed for user ${userId}: ` +
      `${insertResult.error.message} (code: ${insertResult.error.code}).`
    );
    // Fall through to defaults. always_ask is the safest assumption.
    return {
      user_id: userId,
      default_mode: "always_ask",
      auto_below_threshold_usd: null,
      trusted_services: [],
      notification_channels: ["email"],
      telegram_chat_id: null,
      email_for_consent: null,
    };
  }

  return mapConsentPreferencesRow(
    insertResult.data as unknown as RawConsentPreferencesRow
  );
}

export interface ConsentRequestRecord {
  id: string;
  user_id: string;
  action: string;
  service: string;
  amount_usd: number | null;
  context: Record<string, unknown> | null;
  options: string[];
  status: ConsentStatus;
  decision: string | null;
  decision_metadata: Record<string, unknown> | null;
  decision_made_at: string | null;
  expires_at: string;
  created_at: string;
}

interface RawConsentRequestRow {
  id: string;
  user_id: string;
  action: string;
  service: string;
  amount_usd: number | null;
  context: unknown;
  options: unknown;
  status: ConsentStatus;
  decision: string | null;
  decision_metadata: unknown;
  decision_made_at: string | null;
  expires_at: string;
  created_at: string;
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function mapConsentRequestRow(row: RawConsentRequestRow): ConsentRequestRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    action: row.action,
    service: row.service,
    amount_usd: row.amount_usd,
    context: asJsonObject(row.context),
    options: coerceStringArray(row.options),
    status: row.status,
    decision: row.decision,
    decision_metadata: asJsonObject(row.decision_metadata),
    decision_made_at: row.decision_made_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

interface CreateConsentRequestParams {
  userId: string;
  action: string;
  service: string;
  amountUsd?: number;
  context?: Record<string, unknown>;
  options: string[];
  expiresAt: Date;
}

/**
 * Insert a fresh consent_requests row in status='pending'.
 *
 * Throws on insert failure — the MCP tool surfaces that as an infrastructure
 * error rather than silently returning a stub.
 */
export async function createConsentRequest(
  params: CreateConsentRequestParams
): Promise<ConsentRequestRecord> {
  const { data, error } = await supabase
    .from("consent_requests")
    .insert({
      user_id: params.userId,
      action: params.action,
      service: params.service,
      amount_usd: params.amountUsd ?? null,
      context: params.context ?? null,
      options: params.options,
      status: "pending" satisfies ConsentStatus,
      expires_at: params.expiresAt.toISOString(),
    })
    .select(
      "id, user_id, action, service, amount_usd, context, options, status, " +
      "decision, decision_metadata, decision_made_at, expires_at, created_at"
    )
    .single();

  if (error || !data) {
    const message = error?.message ?? "no row returned from insert";
    console.error(
      `[db] createConsentRequest: failed to insert for user ${params.userId} ` +
      `action="${params.action}" service="${params.service}": ${message}`
    );
    throw new Error(`Failed to create consent request: ${message}`);
  }

  return mapConsentRequestRow(data as unknown as RawConsentRequestRow);
}

/**
 * Fetch a consent_requests row and verify it belongs to the caller.
 *
 * Returns null for both "not found" and "exists but belongs to a different
 * user" — distinguishing the two would let a caller probe for valid IDs.
 */
export async function getConsentRequest(
  id: string,
  userId: string
): Promise<ConsentRequestRecord | null> {
  const { data, error } = await supabase
    .from("consent_requests")
    .select(
      "id, user_id, action, service, amount_usd, context, options, status, " +
      "decision, decision_metadata, decision_made_at, expires_at, created_at"
    )
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (error.code !== "PGRST116") {
      console.error(
        `[db] getConsentRequest: unexpected error (code: ${error.code}): ` +
        `${error.message}. id=${id} user=${userId}`
      );
    }
    return null;
  }

  if (!data) return null;
  return mapConsentRequestRow(data as unknown as RawConsentRequestRow);
}

/**
 * Poll `consent_requests.status` for the given row until it leaves
 * 'pending', the row's `expires_at` passes, or `maxWaitMs` elapses —
 * whichever comes first.
 *
 * Returns the final row state. If the deadline passes while the row is
 * still 'pending', this function also writes the row back to status
 * 'expired' so the dashboard reflects reality.
 *
 * `intervalMs` is the time between polls; values below 500ms are clamped to
 * 500 to avoid hammering the DB on a misconfigured caller.
 */
export async function pollConsentDecision(params: {
  id: string;
  userId: string;
  intervalMs: number;
  maxWaitMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ConsentRequestRecord | null> {
  const interval = Math.max(500, params.intervalMs);
  const deadline = (params.now ?? Date.now)() + params.maxWaitMs;
  const sleep =
    params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = params.now ?? Date.now;

  // One initial read so very fast decisions return immediately.
  let row = await getConsentRequest(params.id, params.userId);
  if (!row) return null;
  if (row.status !== "pending") return row;

  while (now() < deadline) {
    const sinceExpiry = now() - new Date(row.expires_at).getTime();
    if (sinceExpiry >= 0) {
      // Past expires_at — mark expired and stop polling.
      const expired = await markConsentExpiredIfPending(params.id);
      return expired ?? row;
    }
    const remaining = deadline - now();
    await sleep(Math.min(interval, Math.max(0, remaining)));
    row = await getConsentRequest(params.id, params.userId);
    if (!row) return null;
    if (row.status !== "pending") return row;
  }

  // Timed out on our side. If the row's own deadline has also passed we
  // mark it expired; otherwise we return it pending and let the caller
  // surface "the request remains pending — call check_consent_status".
  if (new Date(row.expires_at).getTime() <= now()) {
    const expired = await markConsentExpiredIfPending(params.id);
    return expired ?? row;
  }
  return row;
}

/**
 * Record the user's decision on a pending consent_requests row.
 *
 * The CAS-style filter (`.eq("status", "pending")`) guarantees we only
 * write a decision once — a second concurrent submit_consent_decision call
 * receives `null` and surfaces "Already decided" to the agent. Ownership
 * is enforced by filtering on `user_id` as well so a token cannot decide
 * another user's row.
 *
 * Returns the updated row when the transition happens, or null when the
 * row is missing, owned by someone else, or already non-pending.
 */
export async function recordConsentDecision(params: {
  id: string;
  userId: string;
  status: Extract<ConsentStatus, "approved" | "declined">;
  decision: string;
  decisionMetadata?: Record<string, unknown>;
}): Promise<ConsentRequestRecord | null> {
  const patch: Record<string, unknown> = {
    status: params.status,
    decision: params.decision,
    decision_made_at: new Date().toISOString(),
  };
  if (params.decisionMetadata !== undefined) {
    patch["decision_metadata"] = params.decisionMetadata;
  }

  const { data, error } = await supabase
    .from("consent_requests")
    .update(patch)
    .eq("id", params.id)
    .eq("user_id", params.userId)
    .eq("status", "pending")
    .select(
      "id, user_id, action, service, amount_usd, context, options, status, " +
      "decision, decision_metadata, decision_made_at, expires_at, created_at"
    )
    .maybeSingle();

  if (error) {
    console.error(
      `[db] recordConsentDecision: failed for id=${params.id} ` +
      `user=${params.userId}: ${error.message} (code: ${error.code}).`
    );
    throw new Error(`Failed to record consent decision: ${error.message}`);
  }
  if (!data) return null;
  return mapConsentRequestRow(data as unknown as RawConsentRequestRow);
}

// ---------------------------------------------------------------------------
// Subscriptions
//
// Recurring charges (Vercel Pro $20/mo, Netflix, Spotify, …) are persisted as
// `subscriptions` rows. `pay_for_service` is one-shot — these helpers back the
// `subscribe_service` / `cancel_subscription` / `list_subscriptions` MCP tools
// and the dashboard /dashboard/subscriptions page. The renewal cron that
// charges each row on next_charge_at is out of scope for V2 (see CLAUDE.md).
// ---------------------------------------------------------------------------

export type SubscriptionInterval = "monthly" | "yearly" | "weekly";
export type SubscriptionStatus =
  | "active"
  | "paused"
  | "cancelled"
  | "past_due";

export interface SubscriptionRecord {
  id: string;
  user_id: string;
  service: string;
  amount_usd: number;
  currency: string;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  description: string | null;
  started_at: string;
  next_charge_at: string;
  last_charged_at: string | null;
  cancelled_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface RawSubscriptionRow {
  id: string;
  user_id: string;
  service: string;
  // numeric(10,2) — Supabase returns these as strings to preserve precision.
  amount_usd: number | string;
  currency: string;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  description: string | null;
  started_at: string;
  next_charge_at: string;
  last_charged_at: string | null;
  cancelled_at: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

function mapSubscriptionRow(row: RawSubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    service: row.service,
    amount_usd: typeof row.amount_usd === "string" ? Number(row.amount_usd) : row.amount_usd,
    currency: row.currency,
    interval: row.interval,
    status: row.status,
    description: row.description,
    started_at: row.started_at,
    next_charge_at: row.next_charge_at,
    last_charged_at: row.last_charged_at,
    cancelled_at: row.cancelled_at,
    metadata: asJsonObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SUBSCRIPTION_SELECT =
  "id, user_id, service, amount_usd, currency, interval, status, description, " +
  "started_at, next_charge_at, last_charged_at, cancelled_at, metadata, " +
  "created_at, updated_at";

/**
 * Compute the next renewal date by adding one interval to `from`. Used at
 * creation time and (in V3) by the renewal cron after a successful charge.
 * UTC arithmetic — daylight-saving shifts must not move the renewal date.
 */
export function computeNextChargeAt(
  from: Date,
  interval: SubscriptionInterval
): Date {
  const next = new Date(from.getTime());
  switch (interval) {
    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case "monthly":
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    case "yearly":
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      return next;
  }
}

interface CreateSubscriptionParams {
  userId: string;
  service: string;
  amountUsd: number;
  currency?: string;
  interval: SubscriptionInterval;
  description?: string;
  nextChargeAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a new active subscription row. Throws on insert failure — the caller
 * (subscribe_service tool) surfaces that as an infrastructure error rather
 * than silently confirming a recurring schedule we never persisted.
 */
export async function createSubscription(
  params: CreateSubscriptionParams
): Promise<SubscriptionRecord> {
  const { data, error } = await supabase
    .from("subscriptions")
    .insert({
      user_id: params.userId,
      service: params.service,
      amount_usd: params.amountUsd,
      currency: params.currency ?? "USD",
      interval: params.interval,
      status: "active" satisfies SubscriptionStatus,
      description: params.description ?? null,
      next_charge_at: params.nextChargeAt.toISOString(),
      metadata: params.metadata ?? null,
    })
    .select(SUBSCRIPTION_SELECT)
    .single();

  if (error || !data) {
    const message = error?.message ?? "no row returned from insert";
    console.error(
      `[db] createSubscription: failed to insert for user ${params.userId} ` +
      `service "${params.service}": ${message}`
    );
    throw new Error(`Failed to create subscription: ${message}`);
  }

  return mapSubscriptionRow(data as unknown as RawSubscriptionRow);
}

/**
 * Fetch a single subscription, scoped to the calling user.
 *
 * Returns null for both "not found" and "exists but owned by someone else" —
 * indistinguishable from the caller's perspective to prevent ID probing.
 */
export async function getSubscription(
  id: string,
  userId: string
): Promise<SubscriptionRecord | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(SUBSCRIPTION_SELECT)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (error.code !== "PGRST116") {
      console.error(
        `[db] getSubscription: unexpected error (code: ${error.code}): ${error.message}. ` +
        `id=${id} user=${userId}`
      );
    }
    return null;
  }
  if (!data) return null;
  return mapSubscriptionRow(data as unknown as RawSubscriptionRow);
}

/**
 * List all subscriptions for a user. Ordered "active first, then by next
 * renewal" so the dashboard and `list_subscriptions` MCP tool both surface
 * the most relevant rows at the top without further client-side sorting.
 */
export async function listSubscriptionsForUser(
  userId: string
): Promise<SubscriptionRecord[]> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(SUBSCRIPTION_SELECT)
    .eq("user_id", userId)
    .order("status", { ascending: true })
    .order("next_charge_at", { ascending: true });

  if (error) {
    console.error(
      `[db] listSubscriptionsForUser: failed for user ${userId}: ` +
      `${error.message} (code: ${error.code}).`
    );
    throw new Error(`Could not load subscriptions: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as RawSubscriptionRow[];
  return rows.map(mapSubscriptionRow);
}

/**
 * Transition a subscription to 'cancelled'. Idempotent: a row that is already
 * cancelled is returned unchanged. Returns null for unknown / not-owned rows.
 *
 * The CAS filter on `user_id` prevents a stolen subscription ID from being
 * cancelled by anyone other than the owner — same pattern as the consent
 * decision flow.
 */
export async function cancelSubscription(
  id: string,
  userId: string
): Promise<SubscriptionRecord | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .update({
      status: "cancelled" satisfies SubscriptionStatus,
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select(SUBSCRIPTION_SELECT)
    .maybeSingle();

  if (error) {
    console.error(
      `[db] cancelSubscription: failed for id=${id} user=${userId}: ` +
      `${error.message} (code: ${error.code}).`
    );
    throw new Error(`Failed to cancel subscription: ${error.message}`);
  }

  if (!data) return null;
  return mapSubscriptionRow(data as unknown as RawSubscriptionRow);
}

// ===========================================================================
// Virtual phones + inbound SMS (migration 008_virtual_phone.sql)
//
// Spendex provisions a Twilio number per user so SMS verification codes
// land in our infrastructure instead of the user's personal phone. The
// `get_sms_code` MCP tool reads from here; the /api/webhooks/twilio-sms
// route writes here.
// ===========================================================================

export interface VirtualPhoneRecord {
  id: string;
  user_id: string;
  e164_number: string;
  twilio_sid: string;
  provisioned_at: string;
  released_at: string | null;
}

export interface SmsMessageRecord {
  id: string;
  virtual_phone_id: string;
  from_number: string;
  body: string;
  extracted_code: string | null;
  received_at: string;
  consumed_at: string | null;
}

/**
 * Return the user's active (not-released) virtual phone, if any. The
 * one_active_per_user unique constraint guarantees at most one such row.
 */
export async function getActiveVirtualPhone(
  userId: string
): Promise<VirtualPhoneRecord | null> {
  const { data, error } = await supabase
    .from("virtual_phones")
    .select("id, user_id, e164_number, twilio_sid, provisioned_at, released_at")
    .eq("user_id", userId)
    .is("released_at", null)
    .maybeSingle();

  if (error) {
    console.error(
      `[db] getActiveVirtualPhone: unexpected error (code: ${error.code}): ${error.message}. ` +
      `user=${userId}.`
    );
    return null;
  }
  if (!data) return null;
  return data as VirtualPhoneRecord;
}

/**
 * Read the most recent unconsumed SMS for a virtual phone, then atomically
 * mark it consumed so the next caller does not get the same code. We use a
 * conditional update on `consumed_at IS NULL` so that two concurrent reads
 * cannot both "win" — exactly one returns the row.
 *
 * Returns null when there is no unread SMS or when another caller raced us.
 */
export async function consumeLatestSmsForPhone(
  virtualPhoneId: string
): Promise<SmsMessageRecord | null> {
  // 1. Find the candidate row.
  const { data: candidate, error: selectError } = await supabase
    .from("sms_messages")
    .select(
      "id, virtual_phone_id, from_number, body, extracted_code, received_at, consumed_at"
    )
    .eq("virtual_phone_id", virtualPhoneId)
    .is("consumed_at", null)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectError) {
    console.error(
      `[db] consumeLatestSmsForPhone: select failed (code: ${selectError.code}): ${selectError.message}. ` +
      `virtual_phone_id=${virtualPhoneId}.`
    );
    return null;
  }
  if (!candidate) return null;

  const row = candidate as SmsMessageRecord;

  // 2. Atomically mark it consumed. The `.is("consumed_at", null)` predicate
  // means a concurrent reader that already marked this row will cause our
  // update to affect zero rows — we return null in that case so the caller
  // can retry or wait.
  const consumedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("sms_messages")
    .update({ consumed_at: consumedAt })
    .eq("id", row.id)
    .is("consumed_at", null)
    .select(
      "id, virtual_phone_id, from_number, body, extracted_code, received_at, consumed_at"
    )
    .maybeSingle();

  if (updateError) {
    console.error(
      `[db] consumeLatestSmsForPhone: update failed (code: ${updateError.code}): ${updateError.message}. ` +
      `id=${row.id}.`
    );
    return null;
  }
  if (!updated) return null;
  return updated as SmsMessageRecord;
}

/**
 * Best-effort transition pending → expired. Returns the updated row on
 * success, or null if the row was already non-pending (someone else
 * decided just before us).
 */
async function markConsentExpiredIfPending(
  id: string
): Promise<ConsentRequestRecord | null> {
  const { data, error } = await supabase
    .from("consent_requests")
    .update({
      status: "expired" satisfies ConsentStatus,
      decision_made_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select(
      "id, user_id, action, service, amount_usd, context, options, status, " +
      "decision, decision_metadata, decision_made_at, expires_at, created_at"
    )
    .maybeSingle();

  if (error) {
    console.error(
      `[db] markConsentExpiredIfPending: failed for id=${id}: ` +
      `${error.message} (code: ${error.code}).`
    );
    return null;
  }
  if (!data) return null;
  return mapConsentRequestRow(data as unknown as RawConsentRequestRow);
}
