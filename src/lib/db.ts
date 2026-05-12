import { createHmac } from "node:crypto";
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
  _service: string
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
    }
  }

  return [{
    id: rows[0].id,
    user_id: userId,
    service_filter: null,
    max_per_transaction_usd: maxPerTx,
    monthly_budget_usd: monthlyBudget,
    allowed_services: allowed,
    blocked_services: blocked,
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
