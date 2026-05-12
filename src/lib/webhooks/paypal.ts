/**
 * PayPal webhook handler.
 *
 * Designed to be called from the dashboard Next.js app, which owns the HTTP
 * layer. This module is pure business logic — it receives the raw body and
 * the full set of PayPal-supplied HTTP headers, verifies the signature via
 * PayPal's verification API, then dispatches to the appropriate event handler.
 *
 * Supported events:
 *   PAYMENT.CAPTURE.COMPLETED  — async capture confirmation; update audit log
 *   PAYMENT.CAPTURE.DENIED     — capture was rejected by PayPal; update audit log
 *   PAYMENT.CAPTURE.REVERSED   — funds returned to the customer; update audit log
 *   CUSTOMER.DISPUTE.CREATED   — dispute opened; log all details, escalate to on-call
 *   CUSTOMER.DISPUTE.RESOLVED  — dispute closed; log resolution outcome
 *
 * Signature verification is mandatory. PayPal uses an asymmetric certificate-
 * based scheme — there is no simple HMAC secret. Every incoming request must
 * pass PayPal's /v1/notifications/verify-webhook-signature API before any
 * business logic executes. Requests that fail verification are rejected with
 * an error so the HTTP layer can return 400.
 *
 * Docs:
 *   Verification API:  https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature
 *   Event catalog:     https://developer.paypal.com/api/rest/webhooks/event-names/
 */

import { config } from "../../config.js";
import { getAccessToken } from "../payments/paypal.js";
import { updateAuditLogStatus } from "../db.js";

// ---------------------------------------------------------------------------
// PayPal API base — mirrors the constant in paypal.ts so verification hits
// the same environment (sandbox vs. production) as payment calls.
// ---------------------------------------------------------------------------

const PAYPAL_API_BASE = config.paypal.sandbox
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";

// ---------------------------------------------------------------------------
// Types for the incoming webhook payload
// ---------------------------------------------------------------------------

/** Minimal shape of a PayPal webhook event body. */
interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  // The resource object varies by event type; we narrow it in each handler.
  resource: Record<string, unknown>;
  summary?: string;
  event_version?: string;
  create_time?: string;
}

/** Response from PayPal's webhook verification endpoint. */
interface VerifyWebhookSignatureResponse {
  verification_status: "SUCCESS" | "FAILURE";
}

/** Shape of a PayPal capture resource (PAYMENT.CAPTURE.*). */
interface PayPalCaptureResource {
  id?: string;
  status?: string;
  amount?: { value?: string; currency_code?: string };
  custom_id?: string;
  invoice_id?: string;
  seller_protection?: { status?: string };
  links?: Array<{ href: string; rel: string; method: string }>;
}

/** Shape of a PayPal dispute resource (CUSTOMER.DISPUTE.*). */
interface PayPalDisputeResource {
  dispute_id?: string;
  reason?: string;
  status?: string;
  dispute_amount?: { value?: string; currency_code?: string };
  dispute_outcome?: { outcome_code?: string; amount_refunded?: { value?: string; currency_code?: string } };
  disputed_transactions?: Array<{
    buyer_transaction_id?: string;
    seller_transaction_id?: string;
    seller?: { email?: string; merchant_id?: string };
  }>;
  create_time?: string;
  update_time?: string;
  links?: Array<{ href: string; rel: string; method: string }>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Process a single PayPal webhook delivery.
 *
 * @param rawBody  The raw request body as a UTF-8 string. Must NOT be parsed
 *                 before being passed here — PayPal's verification API hashes
 *                 the exact bytes received over the wire.
 * @param headers  All HTTP request headers as a lowercase-keyed record.
 *                 PayPal requires: paypal-transmission-id, paypal-transmission-time,
 *                 paypal-cert-url, paypal-auth-algo, paypal-transmission-sig.
 * @throws         If signature verification fails, if PAYPAL_WEBHOOK_ID is not
 *                 configured, or if a handled event handler encounters an
 *                 unrecoverable error (e.g. an audit log write failure).
 */
export async function handlePayPalWebhook(
  rawBody: string,
  headers: Record<string, string>
): Promise<void> {
  // Validate the webhook ID is configured before doing any work.
  const webhookId = process.env["PAYPAL_WEBHOOK_ID"];
  if (!webhookId) {
    throw new Error(
      "[paypal-webhook] PAYPAL_WEBHOOK_ID is not set. " +
      "Set it to the Webhook ID from the PayPal developer dashboard " +
      "(Apps & Credentials → your app → Webhooks)."
    );
  }

  // Parse the body early so we can include the event object in the
  // verification request, as PayPal requires.
  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PayPalWebhookEvent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[paypal-webhook] Failed to parse webhook body as JSON: ${message}. ` +
      `Rejecting event.`
    );
  }

  // Verify the signature via PayPal's API. This must complete successfully
  // before any business logic runs.
  await verifyWebhookSignature({ rawBody, headers, webhookId, event });

  console.error(
    `[paypal-webhook] Verified event type="${event.event_type}" id="${event.id}" ` +
    `create_time="${event.create_time ?? "unknown"}"`
  );

  // Dispatch to the appropriate handler based on the event type.
  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      await handleCaptureCompleted(event);
      break;

    case "PAYMENT.CAPTURE.DENIED":
      await handleCaptureDenied(event);
      break;

    case "PAYMENT.CAPTURE.REVERSED":
      await handleCaptureReversed(event);
      break;

    case "CUSTOMER.DISPUTE.CREATED":
      handleDisputeCreated(event);
      break;

    case "CUSTOMER.DISPUTE.RESOLVED":
      handleDisputeResolved(event);
      break;

    default:
      // Log and return cleanly. PayPal retries events that do not receive a
      // 2xx response, so we must not throw here — we acknowledge receipt and
      // move on. Configure the webhook in the PayPal dashboard to only send
      // the event types listed above to reduce noise.
      console.error(
        `[paypal-webhook] Unhandled event type="${event.event_type}" id="${event.id}". ` +
        `No action taken. Consider removing this event type from the PayPal ` +
        `webhook subscription if it is not needed.`
      );
  }
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the PayPal webhook signature by calling PayPal's verification API.
 *
 * PayPal uses an asymmetric certificate-based scheme rather than a symmetric
 * HMAC secret. Verification requires sending the raw transmission metadata
 * (from the HTTP headers) plus the parsed event body to PayPal's API, which
 * returns "SUCCESS" or "FAILURE". This approach is not vulnerable to timing
 * attacks on the verification result itself, but it does require a live network
 * call on every webhook — the OAuth token cache in paypal.ts amortises the
 * auth overhead.
 *
 * Header reference:
 *   paypal-transmission-id    Unique ID for this webhook delivery attempt
 *   paypal-transmission-time  ISO-8601 timestamp of transmission
 *   paypal-cert-url           URL to the certificate used to sign this event
 *   paypal-auth-algo          Signature algorithm (e.g. "SHA256withRSA")
 *   paypal-transmission-sig   Base64-encoded signature bytes
 *
 * @throws If the verification API call fails or returns FAILURE.
 */
async function verifyWebhookSignature(params: {
  rawBody: string;
  headers: Record<string, string>;
  webhookId: string;
  event: PayPalWebhookEvent;
}): Promise<void> {
  const { headers, webhookId, event } = params;

  // Extract the required headers. PayPal sends them in mixed case but HTTP
  // normalises headers to lowercase, so we read them lowercase.
  const transmissionId = headers["paypal-transmission-id"];
  const transmissionTime = headers["paypal-transmission-time"];
  const certUrl = headers["paypal-cert-url"];
  const authAlgo = headers["paypal-auth-algo"];
  const transmissionSig = headers["paypal-transmission-sig"];

  // All five headers are required. Reject immediately if any are absent —
  // a legitimate PayPal delivery will always include them.
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    const missing = [
      !transmissionId && "paypal-transmission-id",
      !transmissionTime && "paypal-transmission-time",
      !certUrl && "paypal-cert-url",
      !authAlgo && "paypal-auth-algo",
      !transmissionSig && "paypal-transmission-sig",
    ]
      .filter(Boolean)
      .join(", ");

    throw new Error(
      `[paypal-webhook] Missing required PayPal webhook headers: ${missing}. ` +
      `This request does not appear to be a genuine PayPal webhook delivery.`
    );
  }

  // Reuse the cached OAuth token from the payment provider to avoid a
  // redundant token fetch. The verification API uses the same credentials
  // as the payment API.
  const accessToken = await getAccessToken();

  const verifyResponse = await fetch(
    `${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        // PayPal requires the parsed event body here, not the raw string.
        webhook_event: event,
      }),
    }
  );

  if (!verifyResponse.ok) {
    const statusText = verifyResponse.statusText;
    const body = await verifyResponse.text().catch(() => "(unreadable)");
    throw new Error(
      `[paypal-webhook] Signature verification API returned HTTP ${verifyResponse.status} ${statusText}. ` +
      `Response body: ${body}. ` +
      `Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are valid for the ${config.paypal.sandbox ? "sandbox" : "production"} environment.`
    );
  }

  const result = (await verifyResponse.json()) as VerifyWebhookSignatureResponse;

  if (result.verification_status !== "SUCCESS") {
    throw new Error(
      `[paypal-webhook] Signature verification failed for event id="${event.id}" ` +
      `type="${event.event_type}" transmission_id="${transmissionId}". ` +
      `PayPal returned verification_status="${result.verification_status}". ` +
      `Rejecting event — this may indicate a replay attack or misconfigured PAYPAL_WEBHOOK_ID.`
    );
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * PAYMENT.CAPTURE.COMPLETED
 *
 * PayPal fires this when a capture transitions to COMPLETED asynchronously.
 * In most cases the synchronous charge path in paypal.ts already confirmed
 * the capture status and wrote the audit log. This handler exists to catch
 * the edge cases where PayPal's initial capture response was PENDING and the
 * async notification is the definitive confirmation.
 *
 * Action: update the audit log row to "confirmed" if it exists. A missing row
 * is not fatal — it may mean the charge path already wrote "success" and the
 * row predates our transaction_id scheme, or it is a test event.
 */
async function handleCaptureCompleted(event: PayPalWebhookEvent): Promise<void> {
  const capture = event.resource as PayPalCaptureResource;
  const captureId = capture.id ?? "unknown";
  const amountValue = capture.amount?.value ?? "unknown";
  const amountCurrency = capture.amount?.currency_code ?? "USD";
  const sellerProtection = capture.seller_protection?.status ?? "unknown";

  console.error(
    `[paypal-webhook] PAYMENT.CAPTURE.COMPLETED: ` +
    `capture_id="${captureId}" ` +
    `amount="${amountValue} ${amountCurrency}" ` +
    `seller_protection="${sellerProtection}" ` +
    `event_id="${event.id}". ` +
    `Updating audit log to "confirmed".`
  );

  // updateAuditLogStatus logs a warning if no row matches (test event / already
  // confirmed) and throws only on a real database error.
  await updateAuditLogStatus(captureId, "confirmed", {
    paypal_event_id: event.id,
    seller_protection: sellerProtection,
    amount: `${amountValue} ${amountCurrency}`,
  });

  console.error(
    `[paypal-webhook] PAYMENT.CAPTURE.COMPLETED: audit log updated for ` +
    `capture_id="${captureId}".`
  );
}

/**
 * PAYMENT.CAPTURE.DENIED
 *
 * PayPal fires this when a capture attempt is rejected — typically because the
 * funding instrument was declined. For reference transactions (billing
 * agreements) this can happen asynchronously after the initial API call
 * appeared to succeed with a PENDING status.
 *
 * Action: update the audit log to "failed" and log the capture ID prominently
 * so the support team can look up the transaction in the PayPal dashboard.
 */
async function handleCaptureDenied(event: PayPalWebhookEvent): Promise<void> {
  const capture = event.resource as PayPalCaptureResource;
  const captureId = capture.id ?? "unknown";
  const amountValue = capture.amount?.value ?? "unknown";
  const amountCurrency = capture.amount?.currency_code ?? "USD";

  console.error(
    `[paypal-webhook] PAYMENT.CAPTURE.DENIED: ` +
    `capture_id="${captureId}" ` +
    `amount="${amountValue} ${amountCurrency}" ` +
    `event_id="${event.id}" ` +
    `summary="${event.summary ?? "no summary"}". ` +
    `SUPPORT: Look up this capture in the PayPal dashboard to identify the decline reason. ` +
    `Updating audit log to "failed".`
  );

  await updateAuditLogStatus(captureId, "failed", {
    paypal_event_id: event.id,
    amount: `${amountValue} ${amountCurrency}`,
    summary: event.summary,
  });

  console.error(
    `[paypal-webhook] PAYMENT.CAPTURE.DENIED: audit log updated to "failed" for ` +
    `capture_id="${captureId}". ` +
    `The user should be notified that their payment method was declined and ` +
    `prompted to update it in the Spendex Pay dashboard.`
  );
}

/**
 * PAYMENT.CAPTURE.REVERSED
 *
 * PayPal fires this when a previously completed capture is reversed — meaning
 * the funds have been returned to the customer. Reversals differ from disputes:
 * they are initiated by PayPal (e.g. due to a bank-level reversal or compliance
 * action) rather than by the customer. The money is already gone when this
 * event arrives.
 *
 * Action: update the audit log to "reversed", log all available details
 * (capture ID, amount, reason from summary) for the support team, and note
 * that a refund has already been issued so no manual refund action is needed.
 */
async function handleCaptureReversed(event: PayPalWebhookEvent): Promise<void> {
  const capture = event.resource as PayPalCaptureResource;
  const captureId = capture.id ?? "unknown";
  const amountValue = capture.amount?.value ?? "unknown";
  const amountCurrency = capture.amount?.currency_code ?? "USD";
  const captureStatus = capture.status ?? "unknown";
  const invoiceId = capture.invoice_id ?? "none";
  const customId = capture.custom_id ?? "none";

  console.error(
    `[paypal-webhook] PAYMENT.CAPTURE.REVERSED: ` +
    `capture_id="${captureId}" ` +
    `capture_status="${captureStatus}" ` +
    `amount="${amountValue} ${amountCurrency}" ` +
    `invoice_id="${invoiceId}" ` +
    `custom_id="${customId}" ` +
    `event_id="${event.id}" ` +
    `event_create_time="${event.create_time ?? "unknown"}" ` +
    `summary="${event.summary ?? "no summary"}". ` +
    `The customer has already received their money back via the PayPal reversal. ` +
    `No further refund action is required. Updating audit log to "reversed".`
  );

  await updateAuditLogStatus(captureId, "reversed", {
    paypal_event_id: event.id,
    capture_status: captureStatus,
    amount: `${amountValue} ${amountCurrency}`,
    invoice_id: invoiceId,
    custom_id: customId,
    summary: event.summary,
    event_create_time: event.create_time,
  });

  console.error(
    `[paypal-webhook] PAYMENT.CAPTURE.REVERSED: audit log updated to "reversed" for ` +
    `capture_id="${captureId}". ` +
    `SUPPORT: This reversal was initiated by PayPal, not the customer. ` +
    `Review the PayPal dashboard for the full reversal reason and determine ` +
    `whether the associated Spendex service delivery needs to be cancelled or rolled back.`
  );
}

/**
 * CUSTOMER.DISPUTE.CREATED
 *
 * Fired when a customer opens a dispute (chargeback or "Item Not Received" /
 * "Significantly Not as Described" claim) against a Spendex Pay charge. This
 * is a CRITICAL event — PayPal dispute response windows are typically 10-20
 * days and require evidence submission via the PayPal Resolution Center.
 *
 * Action: log ALL dispute fields to stderr so the on-call team sees the full
 * picture immediately in log aggregation without opening the PayPal dashboard.
 * We do not update the audit log here because a dispute does not retroactively
 * invalidate the charge — the funds may still be retained if the dispute is won.
 * Support must handle the response manually via the PayPal Resolution Center.
 */
function handleDisputeCreated(event: PayPalWebhookEvent): void {
  const dispute = event.resource as PayPalDisputeResource;

  const disputeId = dispute.dispute_id ?? "unknown";
  const reason = dispute.reason ?? "unknown";
  const status = dispute.status ?? "unknown";
  const amountValue = dispute.dispute_amount?.value ?? "unknown";
  const amountCurrency = dispute.dispute_amount?.currency_code ?? "USD";
  const createTime = dispute.create_time ?? "unknown";

  // Extract the first disputed transaction's IDs for cross-referencing.
  const firstTx = dispute.disputed_transactions?.[0];
  const buyerTransactionId = firstTx?.buyer_transaction_id ?? "unknown";
  const sellerTransactionId = firstTx?.seller_transaction_id ?? "unknown";
  const sellerEmail = firstTx?.seller?.email ?? "unknown";
  const merchantId = firstTx?.seller?.merchant_id ?? "unknown";

  // Find the PayPal Resolution Center URL from the dispute links if present.
  const resolutionLink =
    dispute.links?.find((l) => l.rel === "appeal" || l.rel === "self")?.href ??
    "https://www.paypal.com/resolutioncenter";

  console.error(
    `[paypal-webhook] CRITICAL — CUSTOMER.DISPUTE.CREATED: ` +
    `dispute_id="${disputeId}" ` +
    `reason="${reason}" ` +
    `status="${status}" ` +
    `amount="${amountValue} ${amountCurrency}" ` +
    `buyer_transaction_id="${buyerTransactionId}" ` +
    `seller_transaction_id="${sellerTransactionId}" ` +
    `seller_email="${sellerEmail}" ` +
    `merchant_id="${merchantId}" ` +
    `create_time="${createTime}" ` +
    `event_id="${event.id}" ` +
    `resolution_center_url="${resolutionLink}". ` +
    `ACTION REQUIRED: Respond to this dispute in the PayPal Resolution Center ` +
    `before the response deadline or the funds will be automatically returned ` +
    `to the customer. Escalate immediately to the support team.`
  );
}

/**
 * CUSTOMER.DISPUTE.RESOLVED
 *
 * Fired when a dispute reaches a final resolution — either in Spendex Pay's
 * favour (dispute won, funds retained) or the customer's favour (dispute lost
 * or settled, funds returned). The outcome_code in the dispute resource
 * indicates who prevailed.
 *
 * Action: log the resolution outcome with all relevant details. Update the
 * audit log only if we can identify the originating capture via a disputed
 * transaction reference — a missing row is not fatal.
 */
function handleDisputeResolved(event: PayPalWebhookEvent): void {
  const dispute = event.resource as PayPalDisputeResource;

  const disputeId = dispute.dispute_id ?? "unknown";
  const status = dispute.status ?? "unknown";
  const reason = dispute.reason ?? "unknown";
  const outcomeCode = dispute.dispute_outcome?.outcome_code ?? "unknown";
  const refundedValue = dispute.dispute_outcome?.amount_refunded?.value;
  const refundedCurrency = dispute.dispute_outcome?.amount_refunded?.currency_code ?? "USD";
  const updateTime = dispute.update_time ?? "unknown";

  // Determine a human-readable outcome for the log message.
  // PayPal outcome codes: RESOLVED_BUYER_FAVOUR, RESOLVED_SELLER_FAVOUR,
  // CANCELED_BY_BUYER, ACCEPTED, DENIED, EXPIRED.
  const outcomeSummary =
    outcomeCode === "RESOLVED_SELLER_FAVOUR"
      ? "Dispute resolved in Spendex Pay's favour — funds retained."
      : outcomeCode === "RESOLVED_BUYER_FAVOUR"
      ? `Dispute resolved in customer's favour — funds returned${refundedValue ? ` (${refundedValue} ${refundedCurrency})` : ""}.`
      : outcomeCode === "CANCELED_BY_BUYER"
      ? "Dispute cancelled by the customer."
      : outcomeCode === "ACCEPTED"
      ? `Dispute accepted by Spendex Pay — refund issued${refundedValue ? ` (${refundedValue} ${refundedCurrency})` : ""}.`
      : outcomeCode === "DENIED"
      ? "Dispute denied — no refund issued."
      : outcomeCode === "EXPIRED"
      ? "Dispute expired without resolution."
      : `Dispute outcome: ${outcomeCode}.`;

  // Log the first disputed transaction ID for audit cross-referencing.
  const sellerTransactionId =
    dispute.disputed_transactions?.[0]?.seller_transaction_id ?? "unknown";

  console.error(
    `[paypal-webhook] CUSTOMER.DISPUTE.RESOLVED: ` +
    `dispute_id="${disputeId}" ` +
    `status="${status}" ` +
    `reason="${reason}" ` +
    `outcome_code="${outcomeCode}" ` +
    `seller_transaction_id="${sellerTransactionId}" ` +
    `update_time="${updateTime}" ` +
    `event_id="${event.id}". ` +
    `${outcomeSummary}`
  );
}
