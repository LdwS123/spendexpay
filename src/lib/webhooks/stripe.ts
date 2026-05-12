/**
 * Stripe webhook handler.
 *
 * Designed to be called from the dashboard Next.js app, which owns the HTTP
 * layer. This module is pure business logic — it receives the raw body and
 * Stripe-Signature header, verifies the signature, then dispatches to the
 * appropriate event handler.
 *
 * Supported events:
 *   payment_intent.succeeded       — ACH/async payment confirmed; mark audit log "confirmed"
 *   payment_intent.payment_failed  — charge was declined or failed; mark audit log "failed"
 *   payment_intent.processing      — ACH debit accepted by the bank; settlement pending
 *   charge.dispute.created         — chargeback filed; log everything for the support team
 *
 * Signature verification is mandatory. Every incoming request must carry a
 * valid Stripe-Signature header. Requests without a verifiable signature are
 * rejected before any database or business logic runs.
 */

import Stripe from "stripe";
import { config } from "../../config.js";
import { stripeClient } from "../payments/stripe.js";
import { updateAuditLogStatus } from "../db.js";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Process a single Stripe webhook delivery.
 *
 * @param rawBody   The raw request body as a UTF-8 string. Must NOT be parsed
 *                  before being passed here — Stripe's signature check hashes
 *                  the exact bytes received over the wire.
 * @param signature The value of the `Stripe-Signature` HTTP header.
 * @throws          If the signature is invalid or if a handled event handler
 *                  throws an unrecoverable error.
 */
export async function handleStripeWebhook(
  rawBody: string,
  signature: string
): Promise<void> {
  // Verify the signature and decode the event in one atomic step.
  // constructEvent throws a Stripe.errors.StripeSignatureVerificationError
  // when the signature does not match — that error propagates to the caller,
  // which should respond with HTTP 400.
  let event: Stripe.Event;
  try {
    event = stripeClient.webhooks.constructEvent(
      rawBody,
      signature,
      config.stripe.webhookSecret
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stripe-webhook] Signature verification failed: ${message}. ` +
      `Ensure STRIPE_WEBHOOK_SECRET matches the signing secret in the Stripe dashboard ` +
      `for this endpoint. Rejecting event.`
    );
    // Re-throw so the HTTP layer can return 400 Bad Request.
    throw err;
  }

  console.error(
    `[stripe-webhook] Received event type="${event.type}" id="${event.id}"`
  );

  switch (event.type) {
    case "payment_intent.succeeded":
      await handlePaymentIntentSucceeded(event);
      break;

    case "payment_intent.payment_failed":
      await handlePaymentIntentFailed(event);
      break;

    case "payment_intent.processing":
      handlePaymentIntentProcessing(event);
      break;

    case "charge.dispute.created":
      handleDisputeCreated(event);
      break;

    default:
      // Log and ignore event types we do not handle. Stripe retries events
      // that do not receive a 2xx response, so we must not throw here — we
      // acknowledge receipt and move on.
      console.error(
        `[stripe-webhook] Unhandled event type="${event.type}" id="${event.id}". ` +
        `No action taken.`
      );
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * payment_intent.succeeded
 *
 * Fired when funds have been captured and settled. For ACH bank transfers this
 * is the final confirmation that the debit cleared — it arrives 1-3 business
 * days after the initial charge. For card payments it may fire immediately
 * after the charge, but the webhook is still worth handling for idempotency.
 *
 * Action: transition the matching audit_log row from its current status to
 * "confirmed" and log the confirmation for the support team.
 */
async function handlePaymentIntentSucceeded(
  event: Stripe.Event
): Promise<void> {
  const intent = event.data.object as Stripe.PaymentIntent;

  console.error(
    `[stripe-webhook] payment_intent.succeeded: PaymentIntent "${intent.id}" ` +
    `amount=${intent.amount} currency=${intent.currency} ` +
    `customer="${intent.customer ?? "none"}" ` +
    `spendex_user_id="${intent.metadata["spendex_user_id"] ?? "unknown"}". ` +
    `Marking audit log row confirmed.`
  );

  await updateAuditLogStatus(intent.id, "confirmed", {
    stripe_event_id: event.id,
    amount_received: intent.amount_received,
    payment_method_types: intent.payment_method_types,
  });

  console.error(
    `[stripe-webhook] payment_intent.succeeded: audit_log updated for ` +
    `transaction_id="${intent.id}". ` +
    `NOTIFY user spendex_user_id="${intent.metadata["spendex_user_id"] ?? "unknown"}" ` +
    `that their payment of ${(intent.amount_received / 100).toFixed(2)} USD has been confirmed.`
  );
}

/**
 * payment_intent.payment_failed
 *
 * Fired when a charge attempt is declined or fails asynchronously. For ACH
 * this can happen days after the initial debit attempt (e.g. insufficient
 * funds discovered on settlement). For cards it fires immediately on decline.
 *
 * Action: transition the matching audit_log row to "failed" and log enough
 * detail for the support team to identify the cause without querying Stripe.
 */
async function handlePaymentIntentFailed(event: Stripe.Event): Promise<void> {
  const intent = event.data.object as Stripe.PaymentIntent;

  // last_payment_error carries the machine-readable decline code and a
  // human-readable message. It may be null for non-card failures.
  const lastError = intent.last_payment_error;
  const declineCode = lastError?.decline_code ?? "none";
  const errorCode = lastError?.code ?? "none";
  const errorMessage = lastError?.message ?? "no error message provided";
  const paymentMethodType = lastError?.payment_method?.type ?? "unknown";

  console.error(
    `[stripe-webhook] payment_intent.payment_failed: PaymentIntent "${intent.id}" ` +
    `amount=${intent.amount} currency=${intent.currency} ` +
    `customer="${intent.customer ?? "none"}" ` +
    `spendex_user_id="${intent.metadata["spendex_user_id"] ?? "unknown"}" ` +
    `payment_method_type="${paymentMethodType}" ` +
    `error_code="${errorCode}" decline_code="${declineCode}" ` +
    `error_message="${errorMessage}". ` +
    `Marking audit log row failed.`
  );

  await updateAuditLogStatus(intent.id, "failed", {
    stripe_event_id: event.id,
    error_code: errorCode,
    decline_code: declineCode,
    error_message: errorMessage,
    payment_method_type: paymentMethodType,
  });

  console.error(
    `[stripe-webhook] payment_intent.payment_failed: audit_log updated for ` +
    `transaction_id="${intent.id}". ` +
    `NOTIFY user spendex_user_id="${intent.metadata["spendex_user_id"] ?? "unknown"}" ` +
    `that their payment failed (${declineCode !== "none" ? declineCode : errorCode}). ` +
    `They should update their payment method in the Spendex Pay dashboard.`
  );
}

/**
 * payment_intent.processing
 *
 * Fired when Stripe has accepted the ACH debit request and forwarded it to
 * the banking network for settlement. This is a normal intermediate state —
 * it does NOT mean the funds have been captured. Final confirmation comes
 * via payment_intent.succeeded (or payment_intent.payment_failed on rejection).
 *
 * Action: log the event for observability. No audit log update needed because
 * the row was written with status="success" (intent submitted) when the MCP
 * tool called the ACH provider. "processing" does not change the business state.
 */
function handlePaymentIntentProcessing(event: Stripe.Event): void {
  const intent = event.data.object as Stripe.PaymentIntent;

  console.error(
    `[stripe-webhook] payment_intent.processing: PaymentIntent "${intent.id}" ` +
    `amount=${intent.amount} currency=${intent.currency} ` +
    `customer="${intent.customer ?? "none"}" ` +
    `spendex_user_id="${intent.metadata["spendex_user_id"] ?? "unknown"}". ` +
    `ACH debit submitted to banking network — settlement expected in 1-3 business days. ` +
    `No audit log update at this stage; awaiting payment_intent.succeeded or payment_intent.payment_failed.`
  );
}

/**
 * charge.dispute.created
 *
 * Fired when a cardholder or bank account holder initiates a chargeback or
 * dispute. This is a CRITICAL event — disputes must be responded to within
 * Stripe's deadline (usually 5-10 days) with evidence, or the funds are
 * automatically returned to the customer.
 *
 * Action: log ALL dispute fields to stderr so the on-call team can see
 * the full picture immediately in log aggregation (Datadog, CloudWatch, etc.)
 * without needing to open the Stripe dashboard.
 *
 * We do NOT update the audit log here because a dispute does not retroactively
 * invalidate the charge — the funds may still be retained if the dispute is won.
 * Support handles disputes manually via the Stripe dashboard.
 */
function handleDisputeCreated(event: Stripe.Event): void {
  const dispute = event.data.object as Stripe.Dispute;

  // Extract the PaymentIntent ID from the charge object if available.
  // dispute.payment_intent can be a string ID or an expanded PaymentIntent object.
  const paymentIntentId =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : (dispute.payment_intent?.id ?? "unknown");

  // dispute.charge can be a string ID or an expanded Charge object.
  const chargeId =
    typeof dispute.charge === "string"
      ? dispute.charge
      : (dispute.charge?.id ?? "unknown");

  console.error(
    `[stripe-webhook] CRITICAL — charge.dispute.created: ` +
    `dispute_id="${dispute.id}" ` +
    `payment_intent="${paymentIntentId}" ` +
    `charge="${chargeId}" ` +
    `amount=${dispute.amount} currency=${dispute.currency} ` +
    `reason="${dispute.reason}" ` +
    `status="${dispute.status}" ` +
    `is_charge_refundable=${dispute.is_charge_refundable} ` +
    `evidence_due_by=${dispute.evidence_details?.due_by ?? "unknown"} ` +
    `evidence_submission_count=${dispute.evidence_details?.submission_count ?? 0} ` +
    `stripe_dashboard_url="https://dashboard.stripe.com/disputes/${dispute.id}". ` +
    `ACTION REQUIRED: Respond to this dispute before the evidence deadline or ` +
    `the funds will be automatically returned to the customer.`
  );
}
