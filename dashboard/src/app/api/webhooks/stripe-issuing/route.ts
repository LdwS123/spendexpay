/**
 * Stripe Issuing real-time authorization webhook.
 *
 * Stripe sends `issuing_authorization.request` events and waits for our
 * response within <2 seconds. We must call either
 *   stripe.issuing.authorizations.approve(authId)
 * or
 *   stripe.issuing.authorizations.decline(authId)
 * before returning HTTP 200. Stripe interprets a non-2xx or a timeout as a
 * decline, so correctness and latency are both critical here.
 *
 * Decision logic (in order of precedence):
 *   1. Dev mode            → always approve, return immediately.
 *   2. Emergency stop      → decline immediately (EMERGENCY_STOP=true).
 *   3. Amount ceiling      → decline if amount > user's max_auto_charge_usd.
 *   4. Monthly budget      → decline if month-to-date spend + amount > max_amount_per_month rule.
 *   5. Allowed services    → decline if merchant is not in the allowed_services rule list.
 *   6. Default             → approve.
 *
 * Hot-path constraints:
 *   - isEmergencyStop() re-reads process.env on every call — never cache it.
 *   - DB reads: one query for user + rules (joined), one for monthly spend aggregate.
 *     If either query fails, decline for safety.
 *   - logAuthorizationAsync is fire-and-forget — never delays the Stripe response.
 *   - All debug output goes to console.error (stderr).
 *
 * Webhook secret:
 *   STRIPE_ISSUING_WEBHOOK_SECRET — separate from STRIPE_WEBHOOK_SECRET so
 *   the two endpoints can be rotated independently.
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { sendChargeNotification } from "@/lib/email";
import { normalizeMerchantName } from "@/lib/merchant-normalize";
import { stripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Supabase client (dashboard-local, not shared with MCP server)
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "[webhook/stripe-issuing] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set."
    );
  }
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpendexUserRow {
  id: string;
  max_auto_charge_usd: number;
  email: string | null;
  display_name: string | null;
}

interface ActiveRule {
  rule_type: string;
  params: Record<string, unknown>;
}

/**
 * Snapshot of the merchant_data block from the Stripe authorization event,
 * plus the normalized service slug. Captured once at the top of the
 * webhook handler and threaded through approve/decline/log so every code
 * path persists identical, raw provider data.
 *
 * `serviceSlug` is what downstream rules (allowed_services / blocked_services)
 * and the dashboard pivot on. `name` is the raw network descriptor — kept
 * so dispute resolution can match against the cardholder's bank statement.
 */
interface MerchantContext {
  name: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  networkId: string | null;
  cardCountry: string | null;
  serviceSlug: string;
}

function extractMerchantContext(
  authorization: Stripe.Issuing.Authorization
): MerchantContext {
  const md = authorization.merchant_data;
  // `card` may be a string ID or expanded object; only the expanded form
  // carries country, so we guard for both shapes.
  const cardCountry =
    typeof authorization.card === "object" && authorization.card !== null
      ? (authorization.card as Stripe.Issuing.Card).cardholder?.billing?.address?.country ?? null
      : null;
  return {
    name: md?.name ?? null,
    city: md?.city ?? null,
    country: md?.country ?? null,
    category: md?.category ?? null,
    networkId: md?.network_id ?? null,
    cardCountry,
    serviceSlug: normalizeMerchantName(md?.name ?? null),
  };
}

// ---------------------------------------------------------------------------
// Env helpers — never cached
// ---------------------------------------------------------------------------

function isDevMode(): boolean {
  return process.env.SPENDEX_DEV === "true";
}

function isEmergencyStop(): boolean {
  return process.env.EMERGENCY_STOP === "true";
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    console.error(
      "[webhook/stripe-issuing] Rejected request: missing stripe-signature header."
    );
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  if (isDevMode()) {
    console.error(
      "[webhook/stripe-issuing] DEV MODE — skipping signature check and approving all authorizations."
    );
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const issuingWebhookSecret = process.env.STRIPE_ISSUING_WEBHOOK_SECRET;
  if (!issuingWebhookSecret) {
    console.error(
      "[webhook/stripe-issuing] STRIPE_ISSUING_WEBHOOK_SECRET is not set. " +
      "Cannot verify webhook signature. Declining for safety."
    );
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, issuingWebhookSecret);
  } catch (err) {
    const message =
      err instanceof Stripe.errors.StripeSignatureVerificationError
        ? "Invalid signature"
        : "Webhook verification failed";
    console.error(`[webhook/stripe-issuing] ${message}:`, err);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (event.type !== "issuing_authorization.request") {
    console.error(
      `[webhook/stripe-issuing] Received unhandled event type="${event.type}" id="${event.id}". ` +
      `No action taken.`
    );
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const authorization = event.data.object as Stripe.Issuing.Authorization;

  console.error(
    `[webhook/stripe-issuing] issuing_authorization.request: ` +
    `auth_id="${authorization.id}" ` +
    `amount=${authorization.amount} currency=${authorization.currency} ` +
    `merchant="${authorization.merchant_data.name ?? "unknown"}" ` +
    `mcc="${authorization.merchant_data.category}" ` +
    `cardholder="${authorization.cardholder}"`
  );

  const merchantCtx = extractMerchantContext(authorization);
  await handleAuthorizationRequest(authorization, merchantCtx);

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Authorization decision
// ---------------------------------------------------------------------------

async function handleAuthorizationRequest(
  authorization: Stripe.Issuing.Authorization,
  merchantCtx: MerchantContext
): Promise<void> {
  const authId = authorization.id;
  const amountCents = authorization.amount;
  const amountUsd = amountCents / 100;
  const merchantName = merchantCtx.name ?? "unknown merchant";
  const merchantCategory = merchantCtx.category ?? "";

  if (!authorization.cardholder) {
    console.error(
      `[webhook/stripe-issuing] No cardholder on authorization auth_id="${authId}". ` +
      `Declining for safety.`
    );
    await declineAuthorization(authId, "unknown", "", amountUsd, merchantCtx, "no_cardholder");
    return;
  }

  const cardholderId =
    typeof authorization.cardholder === "string"
      ? authorization.cardholder
      : authorization.cardholder.id;
  const cardId =
    typeof authorization.card === "string"
      ? authorization.card
      : authorization.card.id;

  // Step 2: Emergency stop.
  if (isEmergencyStop()) {
    console.error(
      `[webhook/stripe-issuing] EMERGENCY STOP active — declining ` +
      `auth_id="${authId}" cardholder="${cardholderId}" amount=$${amountUsd.toFixed(2)}.`
    );
    await declineAuthorization(authId, cardholderId, cardId, amountUsd, merchantCtx, "emergency_stop");
    return;
  }

  // Step 3a: Look up user.
  let user: SpendexUserRow | null = null;
  try {
    user = await lookupUserByCardholderId(cardholderId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[webhook/stripe-issuing] DB lookup failed for cardholder="${cardholderId}": ${message}. ` +
      `Declining auth_id="${authId}" for safety.`
    );
    await declineAuthorization(authId, cardholderId, cardId, amountUsd, merchantCtx, "db_error");
    return;
  }

  if (!user) {
    console.error(
      `[webhook/stripe-issuing] No user found for cardholder="${cardholderId}". ` +
      `Declining auth_id="${authId}".`
    );
    await declineAuthorization(authId, cardholderId, cardId, amountUsd, merchantCtx, "unknown_cardholder");
    return;
  }

  // Step 3b: Amount ceiling.
  if (user.max_auto_charge_usd === 0 || amountUsd > user.max_auto_charge_usd) {
    console.error(
      `[webhook/stripe-issuing] Amount ceiling exceeded: ` +
      `auth_id="${authId}" amount=$${amountUsd.toFixed(2)} ` +
      `max_auto_charge_usd=$${user.max_auto_charge_usd.toFixed(2)} ` +
      `user_id="${user.id}". Declining.`
    );
    await declineAuthorization(authId, user.id, cardId, amountUsd, merchantCtx, "spending_controls");
    return;
  }

  // Step 3c: Fetch active rules for this user.
  let rules: ActiveRule[] = [];
  try {
    rules = await fetchActiveRules(user.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[webhook/stripe-issuing] Failed to fetch rules for user_id="${user.id}": ${message}. ` +
      `Declining auth_id="${authId}" for safety.`
    );
    await declineAuthorization(authId, user.id, cardId, amountUsd, merchantCtx, "db_error");
    return;
  }

  // Step 4: Monthly budget rule.
  const monthlyBudgetRule = rules.find((r) => r.rule_type === "max_amount_per_month");
  if (monthlyBudgetRule) {
    const budgetUsd = Number(monthlyBudgetRule.params.usd ?? 0);
    let monthlySpend = 0;
    try {
      monthlySpend = await fetchMonthlySpend(user.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[webhook/stripe-issuing] Failed to fetch monthly spend for user_id="${user.id}": ${message}. ` +
        `Declining auth_id="${authId}" for safety.`
      );
      await declineAuthorization(authId, user.id, cardId, amountUsd, merchantCtx, "db_error");
      return;
    }

    if (monthlySpend + amountUsd > budgetUsd) {
      console.error(
        `[webhook/stripe-issuing] Monthly budget exceeded: ` +
        `auth_id="${authId}" amount=$${amountUsd.toFixed(2)} ` +
        `month_to_date=$${monthlySpend.toFixed(2)} ` +
        `budget=$${budgetUsd.toFixed(2)} ` +
        `user_id="${user.id}". Declining.`
      );
      await declineAuthorization(authId, user.id, cardId, amountUsd, merchantCtx, "monthly_budget_exceeded");
      return;
    }
  }

  // Step 5: Allowed services rule.
  const allowedServicesRule = rules.find((r) => r.rule_type === "allowed_services");
  if (allowedServicesRule) {
    const allowed = (allowedServicesRule.params.services ?? []) as string[];
    const merchantLower = merchantName.toLowerCase();
    const categoryLower = merchantCategory.toLowerCase();
    const isAllowed = allowed.some(
      (s) => merchantLower.includes(s.toLowerCase()) || categoryLower.includes(s.toLowerCase())
    );

    if (!isAllowed) {
      console.error(
        `[webhook/stripe-issuing] Service not in allowed list: ` +
        `auth_id="${authId}" merchant="${merchantName}" category="${merchantCategory}" ` +
        `allowed=${JSON.stringify(allowed)} user_id="${user.id}". Declining.`
      );
      await declineAuthorization(authId, user.id, cardId, amountUsd, merchantCtx, "service_not_allowed");
      return;
    }
  }

  // Step 6: Blocked merchants rule (exclusion list).
  // Substring match (case-insensitive) against the merchant name. Used to
  // block specific vendors that fall inside the allowed MCC categories — e.g.
  // a user who wants to disallow a particular SaaS even though "software
  // stores" is open. Wins over the MCC allow-list above.
  const blockedServicesRule = rules.find((r) => r.rule_type === "blocked_services");
  if (blockedServicesRule) {
    const blocked = (blockedServicesRule.params.services ?? []) as string[];
    const merchantLower = merchantName.toLowerCase();
    const isBlocked = blocked.some((s) => merchantLower.includes(s.toLowerCase()));

    if (isBlocked) {
      console.error(
        `[webhook/stripe-issuing] Merchant explicitly blocked: ` +
        `auth_id="${authId}" merchant="${merchantName}" ` +
        `blocked=${JSON.stringify(blocked)} user_id="${user.id}". Declining.`
      );
      await declineAuthorization(authId, user.id, cardId, amountUsd, merchantCtx, "merchant_blocked");
      return;
    }
  }

  // Step 7: Per-service caps (use case V2 #5.2).
  //
  // When the merchant maps to a known service slug (e.g. "vercel", "modal"),
  // honor any per_service_monthly_cap / per_service_per_tx_cap rule the user
  // has set for that exact service. Each rule_type lives in its own row so
  // we filter by slug after fetching the rules array — the partial index on
  // params->>'service' from migration 008 keeps this cheap.
  const merchantSlug = merchantCtx.serviceSlug;
  if (merchantSlug && merchantSlug !== "unknown") {
    for (const rule of rules) {
      if (
        rule.rule_type !== "per_service_monthly_cap" &&
        rule.rule_type !== "per_service_per_tx_cap"
      ) {
        continue;
      }
      const ruleService = typeof rule.params.service === "string" ? rule.params.service.toLowerCase() : null;
      if (ruleService !== merchantSlug.toLowerCase()) continue;

      // Hard block: either rule type can carry blocked=true to deny the
      // service outright without needing a cap.
      if (rule.params.blocked === true) {
        console.error(
          `[webhook/stripe-issuing] Per-service block: ` +
          `auth_id="${authId}" service="${merchantSlug}" user_id="${user.id}". Declining.`
        );
        await declineAuthorization(authId, user.id, cardId, amountUsd, merchantCtx, "per_service_blocked");
        return;
      }

      if (
        rule.rule_type === "per_service_per_tx_cap" &&
        typeof rule.params.per_tx_cap_usd === "number" &&
        amountUsd > rule.params.per_tx_cap_usd
      ) {
        console.error(
          `[webhook/stripe-issuing] Per-service per-tx cap exceeded: ` +
          `auth_id="${authId}" service="${merchantSlug}" ` +
          `amount=$${amountUsd.toFixed(2)} cap=$${rule.params.per_tx_cap_usd.toFixed(2)} ` +
          `user_id="${user.id}". Declining.`
        );
        await declineAuthorization(
          authId,
          user.id,
          cardId,
          amountUsd,
          merchantCtx,
          "per_service_per_tx_cap_exceeded"
        );
        return;
      }

      if (
        rule.rule_type === "per_service_monthly_cap" &&
        typeof rule.params.monthly_cap_usd === "number"
      ) {
        // Spend lookup is scoped to this merchant slug — same SQL as the
        // global monthly check but filtered to audit_logs.service = slug.
        let serviceSpend = 0;
        try {
          serviceSpend = await fetchMonthlySpendForService(user.id, merchantSlug);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[webhook/stripe-issuing] Failed to fetch per-service spend for ` +
            `user_id="${user.id}" service="${merchantSlug}": ${message}. ` +
            `Declining auth_id="${authId}" for safety.`
          );
          await declineAuthorization(authId, user.id, cardId, amountUsd, merchantCtx, "db_error");
          return;
        }

        if (serviceSpend + amountUsd > rule.params.monthly_cap_usd) {
          console.error(
            `[webhook/stripe-issuing] Per-service monthly cap exceeded: ` +
            `auth_id="${authId}" service="${merchantSlug}" ` +
            `amount=$${amountUsd.toFixed(2)} month_to_date=$${serviceSpend.toFixed(2)} ` +
            `cap=$${rule.params.monthly_cap_usd.toFixed(2)} user_id="${user.id}". Declining.`
          );
          await declineAuthorization(
            authId,
            user.id,
            cardId,
            amountUsd,
            merchantCtx,
            "per_service_monthly_cap_exceeded"
          );
          return;
        }
      }
    }
  }

  // All checks passed — approve.
  await approveAuthorization(authId, user.id, cardId, amountUsd, merchantCtx, {
    email: user.email,
    displayName: user.display_name,
  });
}

interface NotificationContact {
  email: string | null;
  displayName: string | null;
}

// ---------------------------------------------------------------------------
// Stripe API calls: approve / decline
// ---------------------------------------------------------------------------

async function approveAuthorization(
  authId: string,
  userId: string,
  cardId: string,
  amountUsd: number,
  merchant: MerchantContext,
  contact: NotificationContact
): Promise<void> {
  const merchantLabel = merchant.name ?? "unknown merchant";
  let approved = false;
  try {
    await stripe.issuing.authorizations.approve(authId);
    approved = true;
    console.error(
      `[webhook/stripe-issuing] APPROVED auth_id="${authId}" ` +
      `user_id="${userId}" amount=$${amountUsd.toFixed(2)} merchant="${merchantLabel}".`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[webhook/stripe-issuing] stripe.issuing.authorizations.approve failed ` +
      `for auth_id="${authId}": ${message}. ` +
      `Stripe will treat this as a decline.`
    );
  }

  logAuthorizationAsync({ userId, authorizationId: authId, cardId, amountUsd, merchant, approved: true });

  if (approved && contact.email) {
    void sendChargeNotification({
      to: contact.email,
      displayName: contact.displayName ?? "",
      service: merchantLabel,
      amountUsd,
      transactionId: authId,
    });
  }
}

async function declineAuthorization(
  authId: string,
  userId: string,
  cardId: string,
  amountUsd: number,
  merchant: MerchantContext,
  reason: string
): Promise<void> {
  const merchantLabel = merchant.name ?? "unknown merchant";
  try {
    await stripe.issuing.authorizations.decline(authId);
    console.error(
      `[webhook/stripe-issuing] DECLINED auth_id="${authId}" ` +
      `user_id="${userId}" amount=$${amountUsd.toFixed(2)} merchant="${merchantLabel}" ` +
      `reason="${reason}".`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[webhook/stripe-issuing] stripe.issuing.authorizations.decline failed ` +
      `for auth_id="${authId}": ${message}. ` +
      `Stripe will treat unanswered requests as declines after timeout.`
    );
  }

  logAuthorizationAsync({ userId, authorizationId: authId, cardId, amountUsd, merchant, approved: false, declineReason: reason });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function lookupUserByCardholderId(
  cardholderId: string
): Promise<SpendexUserRow | null> {
  const supabase = getSupabase();

  // Step 1: resolve cardholder -> user_id via virtual_cards.
  // The stripe_cardholder_id lives on virtual_cards (set in api/onboarding),
  // NOT on the users table — querying users directly returns nothing and
  // would auto-decline every authorization.
  const { data: card, error: cardError } = await supabase
    .from("virtual_cards")
    .select("user_id")
    .eq("stripe_cardholder_id", cardholderId)
    .eq("status", "active")
    .maybeSingle();

  if (cardError) {
    throw new Error(
      `Supabase error looking up virtual_cards for cardholder "${cardholderId}": ${cardError.message} (${cardError.code})`
    );
  }

  if (!card) return null;

  // Step 2: fetch the user row by user_id.
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, max_auto_charge_usd, email, display_name")
    .eq("id", card.user_id)
    .maybeSingle();

  if (userError) {
    throw new Error(
      `Supabase error looking up user "${card.user_id}" for cardholder "${cardholderId}": ${userError.message} (${userError.code})`
    );
  }

  if (!user) return null;

  return user as SpendexUserRow;
}

async function fetchActiveRules(userId: string): Promise<ActiveRule[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("rules")
    .select("rule_type, params")
    .eq("user_id", userId)
    .eq("active", true);

  if (error) {
    throw new Error(
      `Supabase error fetching rules for user "${userId}": ${error.message} (${error.code})`
    );
  }

  return (data ?? []) as ActiveRule[];
}

async function fetchMonthlySpend(userId: string): Promise<number> {
  const supabase = getSupabase();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data, error } = await supabase
    .from("audit_logs")
    .select("amount_usd")
    .eq("user_id", userId)
    .eq("status", "success")
    .gte("created_at", monthStart);

  if (error) {
    throw new Error(
      `Supabase error fetching monthly spend for user "${userId}": ${error.message} (${error.code})`
    );
  }

  return (data ?? []).reduce(
    (sum: number, row: { amount_usd: number | null }) => sum + (row.amount_usd ?? 0),
    0
  );
}

/**
 * Same as `fetchMonthlySpend` but filtered to one service. Used by the
 * per-service monthly cap enforcement so a user with a $20 vercel cap is
 * not penalized for spend on other merchants.
 *
 * audit_logs.service stores the normalized slug (see normalizeMerchantName),
 * so the filter is a straight equality check.
 */
async function fetchMonthlySpendForService(
  userId: string,
  service: string
): Promise<number> {
  const supabase = getSupabase();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data, error } = await supabase
    .from("audit_logs")
    .select("amount_usd")
    .eq("user_id", userId)
    .eq("service", service)
    .eq("status", "success")
    .gte("created_at", monthStart);

  if (error) {
    throw new Error(
      `Supabase error fetching per-service monthly spend for user "${userId}" ` +
      `service "${service}": ${error.message} (${error.code})`
    );
  }

  return (data ?? []).reduce(
    (sum: number, row: { amount_usd: number | null }) => sum + (row.amount_usd ?? 0),
    0
  );
}

// ---------------------------------------------------------------------------
// Audit log — fire-and-forget
// ---------------------------------------------------------------------------

interface LogAuthParams {
  userId: string;
  authorizationId: string;
  cardId: string;
  amountUsd: number;
  merchant: MerchantContext;
  approved: boolean;
  declineReason?: string;
}

/**
 * Postgres / PostgREST error codes that mean "the column doesn't exist on
 * the table." When we see one of these, we strip the new merchant_* fields
 * and retry — this lets the webhook keep working before migration 006 has
 * been applied. After migration is in place these codes never fire and
 * the retry path is dead code, but the cost of leaving it in is zero.
 */
const MISSING_COLUMN_CODES = new Set(["42703", "PGRST204"]);

function isMissingColumnError(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code && MISSING_COLUMN_CODES.has(error.code)) return true;
  // PostgREST sometimes surfaces "Could not find the 'merchant_name' column"
  // with no SQLSTATE code attached — fall back to a message sniff.
  const msg = (error.message ?? "").toLowerCase();
  return msg.includes("could not find") && msg.includes("column");
}

function logAuthorizationAsync(params: LogAuthParams): void {
  void (async () => {
    const merchantLabel = params.merchant.name ?? "unknown merchant";
    const basePayload = {
      user_id: params.userId === "unknown" ? null : params.userId,
      service: params.merchant.serviceSlug,
      status: params.approved ? ("success" as const) : ("payment_failed" as const),
      amount_usd: params.amountUsd,
      description: `Issuing authorization ${params.approved ? "approved" : "declined"} for ${merchantLabel}`,
      transaction_id: params.authorizationId,
      error_message: params.declineReason ?? null,
      created_at: new Date().toISOString(),
    };

    const enrichedPayload = {
      ...basePayload,
      merchant_name: params.merchant.name,
      merchant_city: params.merchant.city,
      merchant_country: params.merchant.country,
      merchant_category: params.merchant.category,
      merchant_network_id: params.merchant.networkId,
      card_country: params.merchant.cardCountry,
    };

    try {
      const supabase = getSupabase();
      let { error } = await supabase.from("audit_logs").insert(enrichedPayload);

      // Migration 006 not applied yet: drop the new columns and retry with
      // just the legacy shape so we still capture *something* on disk.
      if (error && isMissingColumnError(error)) {
        console.error(
          `[webhook/stripe-issuing] audit_logs is missing merchant_* columns ` +
          `(code=${error.code}). Falling back to legacy insert for ` +
          `auth_id="${params.authorizationId}". Run migration 006_audit_logs_merchant_data.sql.`
        );
        ({ error } = await supabase.from("audit_logs").insert(basePayload));
      }

      if (error) {
        console.error(
          `[webhook/stripe-issuing] Failed to write audit log for ` +
          `auth_id="${params.authorizationId}" user=${params.userId}: ` +
          `${error.message} (code: ${error.code}). ` +
          `Authorization decision was already delivered to Stripe.`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[webhook/stripe-issuing] Unexpected error writing audit log for ` +
        `auth_id="${params.authorizationId}": ${message}.`
      );
    }
  })();
}
