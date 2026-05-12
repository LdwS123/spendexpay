/**
 * Webhook handler for Circle Programmable Wallets transfer events.
 *
 * Circle delivers webhook notifications via AWS SNS. The outer envelope is a
 * JSON object with `Type` and `Message` fields, where `Message` is itself a
 * JSON-encoded string that must be parsed separately to reach the Circle event
 * payload. This two-layer structure is standard for SNS HTTP subscriptions.
 *
 * We use these webhooks to reconcile USDC/Base transfers that timed out during
 * the 30-second polling window in src/lib/payments/usdc-base.ts — for example,
 * a Base L2 transaction that was still in-flight when polling stopped.
 *
 * Verification: Circle does not provide HMAC signing on the raw body. Instead,
 * each webhook subscription has a unique `subscriptionId`. We verify that the
 * subscriptionId in the incoming payload matches the one we registered, so only
 * our own Circle subscription can trigger state changes in our audit log.
 *
 * Docs: https://developers.circle.com/w3s/docs/programmable-wallets-webhooks
 */

import { updateAuditLogStatus } from "../db.js";

// The transfer-level event types emitted by Circle Programmable Wallets.
// Other Circle products (Payments, Payouts) use different event namespaces.
type CircleTransferEventType =
  | "transfers.transfer.confirmed"
  | "transfers.transfer.failed"
  | string; // allow unknown types without a compile error

// The inner Circle event payload, parsed out of the SNS Message field.
interface CircleTransferEvent {
  subscriptionId: string;
  notificationType: CircleTransferEventType;
  transfer: {
    // The Circle transfer UUID we stored in audit_log.transaction_id.
    id: string;
    state: "running" | "complete" | "failed";
  };
}

// The outer SNS-style envelope that Circle POSTs to our webhook endpoint.
interface CircleSnsEnvelope {
  // SNS message type: "Notification", "SubscriptionConfirmation", or "UnsubscribeConfirmation".
  Type: string;
  // For Type="Notification": a JSON-encoded CircleTransferEvent string.
  Message?: string;
  // For Type="SubscriptionConfirmation": the URL to GET to confirm the subscription.
  SubscribeURL?: string;
}

/**
 * Map Circle transfer event types to the audit_log status values we persist.
 * Returns null for event types we intentionally ignore.
 */
function resolveAuditStatus(eventType: CircleTransferEventType): string | null {
  switch (eventType) {
    case "transfers.transfer.confirmed":
      // Transfer completed and settled on-chain. Safe to credit the user.
      return "payment_confirmed";
    case "transfers.transfer.failed":
      // Transfer was definitively rejected by Circle or the chain. No funds moved.
      return "payment_failed";
    default:
      return null;
  }
}

/**
 * Verify that the subscriptionId in the event payload matches the value we
 * registered in the Circle dashboard. This is the primary authenticity check
 * for Circle webhooks (Circle does not sign the raw body with HMAC).
 *
 * @throws if the env var is missing or the IDs do not match.
 */
function verifySubscriptionId(received: string): void {
  const expected = process.env["CIRCLE_WEBHOOK_SUBSCRIPTION_ID"];
  if (!expected) {
    throw new Error(
      "[circle-webhook] CIRCLE_WEBHOOK_SUBSCRIPTION_ID is not set. " +
      "Configure it in the environment before enabling Circle webhooks."
    );
  }

  if (received !== expected) {
    throw new Error(
      "[circle-webhook] Subscription ID mismatch — the inbound webhook did not " +
      "originate from our registered Circle subscription. Rejecting."
    );
  }
}

/**
 * Handle an inbound Circle webhook notification.
 *
 * Circle delivers events wrapped in an SNS-style envelope:
 *   - The outer body has `Type` and `Message` fields.
 *   - `Message` is a JSON-encoded string containing the actual Circle event.
 *
 * This function handles the two envelope types we care about:
 *   - `SubscriptionConfirmation`: logged and silently accepted (no DB write).
 *   - `Notification`: parsed, verified, and used to update the audit log.
 *
 * The caller should respond with HTTP 200 on success and HTTP 400/500 on any
 * thrown error. Circle retries delivery on non-2xx responses.
 *
 * @param rawBody        - The raw UTF-8 request body string from Circle.
 * @param subscriptionId - The subscriptionId extracted from the parsed envelope
 *                         (passed separately so the caller can extract it from
 *                         the parsed JSON before calling this function, or pass
 *                         an empty string to let this function parse it internally).
 *                         If empty, the function parses it from rawBody itself.
 */
export async function handleCircleWebhook(
  rawBody: string,
  subscriptionId: string
): Promise<void> {
  let envelope: CircleSnsEnvelope;
  try {
    envelope = JSON.parse(rawBody) as CircleSnsEnvelope;
  } catch (err) {
    throw new Error(
      `[circle-webhook] Failed to parse outer SNS envelope as JSON: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Handle SNS subscription confirmation. Circle sends this once when the
  // webhook endpoint is first registered. We do not need to do anything with it
  // beyond acknowledging receipt (returning without error → HTTP 200).
  if (envelope.Type === "SubscriptionConfirmation") {
    // Log the SubscribeURL so an operator can confirm the subscription manually
    // if auto-confirmation is not set up. Not an error — just informational.
    console.error(
      "[circle-webhook] Received SNS SubscriptionConfirmation. " +
      `SubscribeURL: ${envelope.SubscribeURL ?? "(not provided)"}`
    );
    return;
  }

  if (envelope.Type !== "Notification") {
    // Unknown SNS message type — log and return without error so Circle
    // receives a 200 and does not retry an inherently unactionable message.
    console.error(
      `[circle-webhook] Unrecognized SNS message type "${envelope.Type}". Ignoring.`
    );
    return;
  }

  // Parse the inner Message string. Circle encodes the actual event payload
  // as a JSON string nested inside the SNS envelope's `Message` field.
  if (!envelope.Message) {
    throw new Error(
      "[circle-webhook] SNS Notification envelope is missing the Message field."
    );
  }

  let event: CircleTransferEvent;
  try {
    event = JSON.parse(envelope.Message) as CircleTransferEvent;
  } catch (err) {
    throw new Error(
      `[circle-webhook] Failed to parse inner Circle event from SNS Message: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }

  // If the caller did not extract the subscriptionId beforehand, fall back to
  // the one embedded in the parsed event payload.
  const resolvedSubscriptionId =
    subscriptionId.length > 0 ? subscriptionId : event.subscriptionId;

  verifySubscriptionId(resolvedSubscriptionId);

  if (!event.notificationType || !event.transfer?.id) {
    throw new Error(
      "[circle-webhook] Circle event payload is missing required fields " +
      "(notificationType or transfer.id). Cannot process."
    );
  }

  const auditStatus = resolveAuditStatus(event.notificationType);

  if (auditStatus === null) {
    // Informational event — nothing to persist. Return silently so Circle
    // receives a 200 and does not retry delivery unnecessarily.
    return;
  }

  const transferId = event.transfer.id;

  try {
    await updateAuditLogStatus(transferId, auditStatus);
  } catch (err) {
    // Log with enough context for an on-call engineer, then re-throw so the
    // HTTP layer returns a 500 and Circle retries the delivery.
    console.error(
      `[circle-webhook] Failed to update audit_log for transfer ${transferId} ` +
      `(event: ${event.notificationType}, target status: ${auditStatus}): ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
}
