/**
 * Stripe classic-events webhook handler.
 *
 * This endpoint receives non-Issuing Stripe events that relate to charges on
 * the *user's own* payment method (the card or wallet they registered with
 * Spendex), as opposed to the Issuing webhook which handles real-time
 * authorizations on Spendex-issued virtual cards.
 *
 * Events handled:
 *   - payment_intent.succeeded       → mark audit_logs row as success
 *   - payment_intent.payment_failed  → mark audit_logs row as payment_failed
 *   - setup_intent.succeeded         → informational log (card already saved
 *                                       by /api/payments/confirm)
 *   - charge.refunded                → insert a negative audit_logs row
 *
 * Security:
 *   STRIPE_WEBHOOK_SECRET must be set or the handler refuses to process the
 *   request (HTTP 500). Without signature verification, anyone could forge
 *   payment events.
 *
 * Latency:
 *   We always return 200 quickly after the DB write completes. Stripe retries
 *   non-2xx responses with exponential backoff, so silent retries from
 *   internal errors are tolerable, but signature failures are 400 (Stripe
 *   stops retrying those).
 *
 * Logging:
 *   All diagnostics go to console.error (stderr). The MCP server sibling
 *   process treats stdout as the JSON-RPC channel; the dashboard does not,
 *   but we keep the convention for grep parity across the project.
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Stripe signature verification requires the exact bytes sent over the wire.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Stripe client
// ---------------------------------------------------------------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-02-24.acacia",
});

// ---------------------------------------------------------------------------
// Supabase admin client (service-role; bypasses RLS)
// ---------------------------------------------------------------------------

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "[webhook/stripe] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set."
    );
  }
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Audit-log row shape (subset of columns we read)
// ---------------------------------------------------------------------------

interface AuditLogRow {
  id: string;
  user_id: string | null;
  service: string | null;
  amount_usd: number | null;
  description: string | null;
  transaction_id: string | null;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    console.error(
      "[webhook/stripe] Rejected request: missing stripe-signature header."
    );
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "[webhook/stripe] STRIPE_WEBHOOK_SECRET is not set. " +
        "Cannot verify webhook signature — refusing to process event for security."
    );
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message =
      err instanceof Stripe.errors.StripeSignatureVerificationError
        ? "Invalid signature"
        : "Webhook verification failed";
    console.error(`[webhook/stripe] ${message}:`, err);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Dispatch. Each handler is wrapped in try/catch so that an unexpected
  // error in one event type does not bubble up and cause Stripe to retry —
  // we've already verified the signature, so the request itself was valid.
  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const intent = event.data.object as Stripe.PaymentIntent;
        await handlePaymentSucceeded(intent);
        break;
      }
      case "payment_intent.payment_failed": {
        const intent = event.data.object as Stripe.PaymentIntent;
        await handlePaymentFailed(intent);
        break;
      }
      case "setup_intent.succeeded": {
        const setupIntent = event.data.object as Stripe.SetupIntent;
        handleSetupIntentSucceeded(setupIntent);
        break;
      }
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        await handleChargeRefunded(charge);
        break;
      }
      default:
        console.error(
          `[webhook/stripe] Unhandled event type="${event.type}" id="${event.id}". No action taken.`
        );
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[webhook/stripe] Unexpected error processing event type="${event.type}" id="${event.id}": ${message}.`
    );
    // Still return 200 — the event was authentic, retrying won't fix a code
    // bug. Surface via logs/Sentry instead.
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handlePaymentSucceeded(
  intent: Stripe.PaymentIntent
): Promise<void> {
  const userId = intent.metadata["spendex_user_id"] ?? "unknown";
  const paymentUi = intent.metadata["payment_ui"] ?? "card";

  console.error(
    `[webhook/stripe] payment_intent.succeeded: id="${intent.id}" ` +
      `amount=${intent.amount} user_id="${userId}" ui="${paymentUi}".`
  );

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("audit_logs")
    .update({
      status: "success",
      error_message: null,
    })
    .eq("transaction_id", intent.id)
    .select("id");

  if (error) {
    console.error(
      `[webhook/stripe] Supabase update failed for transaction_id="${intent.id}": ` +
        `${error.message} (code: ${error.code}).`
    );
    return;
  }

  if (!data || data.length === 0) {
    console.error(
      `[webhook/stripe] WARNING: no audit_logs row matched transaction_id="${intent.id}" ` +
        `for payment_intent.succeeded. The row may not have been written yet, or this ` +
        `PaymentIntent was created outside of Spendex.`
    );
    return;
  }

  console.error(
    `[webhook/stripe] audit_logs updated to status="success" for transaction_id="${intent.id}" ` +
      `(${data.length} row${data.length === 1 ? "" : "s"}).`
  );
}

async function handlePaymentFailed(
  intent: Stripe.PaymentIntent
): Promise<void> {
  const userId = intent.metadata["spendex_user_id"] ?? "unknown";
  const lastError = intent.last_payment_error;
  const errorMessage = lastError?.message ?? "Payment failed (no error detail provided by Stripe).";

  console.error(
    `[webhook/stripe] payment_intent.payment_failed: id="${intent.id}" ` +
      `user_id="${userId}" error="${errorMessage}".`
  );

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("audit_logs")
    .update({
      status: "payment_failed",
      error_message: errorMessage,
    })
    .eq("transaction_id", intent.id)
    .select("id");

  if (error) {
    console.error(
      `[webhook/stripe] Supabase update failed for transaction_id="${intent.id}": ` +
        `${error.message} (code: ${error.code}).`
    );
    return;
  }

  if (!data || data.length === 0) {
    console.error(
      `[webhook/stripe] WARNING: no audit_logs row matched transaction_id="${intent.id}" ` +
        `for payment_intent.payment_failed. Logging only.`
    );
    return;
  }

  console.error(
    `[webhook/stripe] audit_logs updated to status="payment_failed" for transaction_id="${intent.id}" ` +
      `(${data.length} row${data.length === 1 ? "" : "s"}).`
  );
}

function handleSetupIntentSucceeded(setupIntent: Stripe.SetupIntent): void {
  const userId = setupIntent.metadata?.["spendex_user_id"] ?? "unknown";
  const customerId =
    typeof setupIntent.customer === "string"
      ? setupIntent.customer
      : setupIntent.customer?.id ?? "unknown";
  const paymentMethodId =
    typeof setupIntent.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id ?? "unknown";

  // The card itself is already saved by /api/payments/confirm. This handler
  // exists so that out-of-band confirmations (e.g. authentication redirects
  // that bypass our client-side code) still leave an audit trail.
  console.error(
    `[webhook/stripe] setup_intent.succeeded: id="${setupIntent.id}" ` +
      `user_id="${userId}" customer="${customerId}" payment_method="${paymentMethodId}". ` +
      `Card-on-file persistence handled by /api/payments/confirm.`
  );
}

async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id ?? null;

  // amount_refunded is in cents — convert to USD.
  const refundedCents = charge.amount_refunded ?? 0;
  if (refundedCents <= 0) {
    console.error(
      `[webhook/stripe] charge.refunded received with amount_refunded=${refundedCents} ` +
        `for charge="${charge.id}". Skipping insert.`
    );
    return;
  }
  const refundUsd = refundedCents / 100;

  // The most recent refund object on the charge gives us a stable transaction id
  // (re_…) and a created timestamp. If somehow absent, fall back to the charge id.
  const latestRefund =
    charge.refunds?.data && charge.refunds.data.length > 0
      ? charge.refunds.data[charge.refunds.data.length - 1]
      : null;
  const refundId = latestRefund?.id ?? `re_for_${charge.id}`;
  const refundCreatedSec = latestRefund?.created ?? charge.created;

  console.error(
    `[webhook/stripe] charge.refunded: charge_id="${charge.id}" ` +
      `payment_intent="${paymentIntentId ?? "none"}" refund_id="${refundId}" ` +
      `amount_refunded=$${refundUsd.toFixed(2)}.`
  );

  const supabase = getSupabaseAdmin();

  // Look up the original audit_logs row so we can attribute the refund to
  // the right user and inherit the original description.
  let originalRow: AuditLogRow | null = null;
  if (paymentIntentId) {
    const { data, error } = await supabase
      .from("audit_logs")
      .select("id, user_id, service, amount_usd, description, transaction_id")
      .eq("transaction_id", paymentIntentId)
      .maybeSingle();

    if (error) {
      console.error(
        `[webhook/stripe] Lookup of original audit_logs row failed for ` +
          `payment_intent="${paymentIntentId}": ${error.message} (code: ${error.code}). ` +
          `Inserting refund row with null user_id.`
      );
    } else if (data) {
      originalRow = data as AuditLogRow;
    } else {
      console.error(
        `[webhook/stripe] WARNING: no original audit_logs row found for ` +
          `payment_intent="${paymentIntentId}". Refund will be logged with null user_id.`
      );
    }
  }

  const originalDescription = originalRow?.description ?? `charge ${charge.id}`;
  const insertedAt = new Date(refundCreatedSec * 1000).toISOString();

  const { error: insertError } = await supabase.from("audit_logs").insert({
    user_id: originalRow?.user_id ?? null,
    service: originalRow?.service ?? "stripe",
    status: "success",
    amount_usd: -refundUsd,
    description: `Refund: ${originalDescription}`,
    transaction_id: refundId,
    error_message: null,
    created_at: insertedAt,
  });

  if (insertError) {
    console.error(
      `[webhook/stripe] Failed to insert refund audit_logs row for refund_id="${refundId}": ` +
        `${insertError.message} (code: ${insertError.code}).`
    );
    return;
  }

  console.error(
    `[webhook/stripe] Refund audit_logs row inserted: refund_id="${refundId}" ` +
      `user_id="${originalRow?.user_id ?? "null"}" amount_usd=${-refundUsd}.`
  );
}
