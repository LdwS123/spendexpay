/**
 * Webhook handler for Coinbase Commerce payment events.
 *
 * Coinbase sends a POST to our webhook endpoint whenever a charge changes
 * state. We use this to reconcile charges that timed out during polling —
 * for example, when a Base L2 or ETH mainnet transfer confirmed after the
 * 5-minute polling window in src/lib/payments/coinbase.ts expired.
 *
 * Verification: Coinbase signs the raw request body with HMAC-SHA256 using
 * the webhook secret from the Commerce dashboard. The signature is sent in
 * the `X-CC-Webhook-Signature` header as a lowercase hex string.
 *
 * Docs: https://docs.cdp.coinbase.com/commerce/docs/webhooks
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { updateAuditLogStatus } from "../db.js";

// The full set of Coinbase Commerce charge event types.
// Only the four we handle below are acted upon; the rest are logged and ignored.
type CoinbaseEventType =
  | "charge:created"
  | "charge:confirmed"
  | "charge:failed"
  | "charge:delayed"
  | "charge:pending"
  | "charge:resolved";

interface CoinbaseWebhookEvent {
  id: string;
  type: CoinbaseEventType;
  data: {
    // The charge object nested inside the event payload.
    // `id` is the Coinbase charge UUID we stored in audit_log.transaction_id.
    id: string;
    code: string;
  };
}

interface CoinbaseWebhookBody {
  event: CoinbaseWebhookEvent;
}

/**
 * Map Coinbase Commerce event types to the audit_log status values we persist.
 * Returns null for event types we intentionally ignore.
 */
function resolveAuditStatus(eventType: CoinbaseEventType): string | null {
  switch (eventType) {
    case "charge:confirmed":
      // Payment completed and funds are available.
      return "payment_confirmed";
    case "charge:pending":
      // Funds detected on-chain but not yet fully confirmed. Useful for
      // fast-path acknowledgment — do not deliver service yet.
      return "payment_pending";
    case "charge:delayed":
      // Payment arrived after the charge expiry window. Coinbase will attempt
      // to refund, but the charge is unusable. Operator must manually reconcile.
      return "payment_delayed";
    case "charge:failed":
      // The charge expired or was explicitly canceled before payment arrived.
      return "payment_failed";
    default:
      // charge:created and charge:resolved are informational — no audit update needed.
      return null;
  }
}

/**
 * Verify the Coinbase Commerce webhook signature.
 *
 * Coinbase signs the raw (unmodified) request body with HMAC-SHA256 using the
 * webhook secret configured in the Commerce dashboard. The resulting hex digest
 * is placed in `X-CC-Webhook-Signature`. We recompute it and compare with
 * `timingSafeEqual` to prevent timing attacks.
 *
 * @throws if the secret is missing from the environment or the signature does not match.
 */
function verifySignature(rawBody: string, signature: string): void {
  const secret = process.env["COINBASE_COMMERCE_WEBHOOK_SECRET"];
  if (!secret) {
    throw new Error(
      "[coinbase-webhook] COINBASE_COMMERCE_WEBHOOK_SECRET is not set. " +
      "Configure it in the environment before enabling Coinbase Commerce webhooks."
    );
  }

  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Both buffers must be the same length before timingSafeEqual — if they
  // differ in length the comparison would short-circuit, leaking timing info.
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signature, "utf8");

  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    throw new Error(
      "[coinbase-webhook] Signature verification failed. " +
      "The request may have been tampered with or sent by an unauthorized party."
    );
  }
}

/**
 * Handle an inbound Coinbase Commerce webhook event.
 *
 * Called by the HTTP route handler (e.g. an Express POST /webhooks/coinbase route
 * or a Next.js API route). The caller is responsible for passing the raw,
 * unparsed request body string and the value of the `X-CC-Webhook-Signature`
 * header exactly as received from Coinbase.
 *
 * Verification is performed first. If verification fails, an error is thrown
 * and the caller should respond with HTTP 400 so Coinbase retries delivery.
 *
 * @param rawBody    - The raw UTF-8 request body string, before any JSON parsing.
 * @param signature  - The value of the `X-CC-Webhook-Signature` request header.
 */
export async function handleCoinbaseWebhook(
  rawBody: string,
  signature: string
): Promise<void> {
  // Verification must happen before any JSON parsing. Parsing before verifying
  // is safe in theory, but verifying first is the conventional order and ensures
  // we never act on a structurally valid but maliciously crafted payload.
  verifySignature(rawBody, signature);

  let body: CoinbaseWebhookBody;
  try {
    body = JSON.parse(rawBody) as CoinbaseWebhookBody;
  } catch (err) {
    throw new Error(
      `[coinbase-webhook] Failed to parse webhook body as JSON: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }

  const { event } = body;

  if (!event?.type || !event?.data?.id) {
    throw new Error(
      "[coinbase-webhook] Webhook payload is missing required fields " +
      "(event.type or event.data.id). Cannot process."
    );
  }

  const auditStatus = resolveAuditStatus(event.type);

  if (auditStatus === null) {
    // This event type is informational — nothing to persist. Return silently
    // so Coinbase receives a 200 and does not retry delivery unnecessarily.
    return;
  }

  // The charge ID stored in audit_log.transaction_id is the Coinbase charge UUID
  // (charge.id), not the human-readable charge code (charge.code).
  const chargeId = event.data.id;

  try {
    await updateAuditLogStatus(chargeId, auditStatus);
  } catch (err) {
    // Log the error with enough context for an on-call engineer to investigate,
    // then re-throw so the HTTP layer can return a 500. A 500 tells Coinbase to
    // retry delivery, which is the correct behavior when our DB write failed.
    console.error(
      `[coinbase-webhook] Failed to update audit_log for charge ${chargeId} ` +
      `(event: ${event.type}, target status: ${auditStatus}): ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
}
