import { NextRequest, NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase";

// PayPal's signature verification requires the exact bytes sent over the wire.
export const dynamic = "force-dynamic";

const PAYPAL_API_BASE =
  process.env.PAYPAL_SANDBOX === "false"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
  summary?: string;
  create_time?: string;
}

interface VerifyWebhookSignatureResponse {
  verification_status: "SUCCESS" | "FAILURE";
}

interface PayPalCaptureResource {
  id?: string;
  status?: string;
  amount?: { value?: string; currency_code?: string };
  custom_id?: string;
  invoice_id?: string;
  seller_protection?: { status?: string };
  links?: Array<{ href: string; rel: string; method: string }>;
}

interface PayPalDisputeResource {
  dispute_id?: string;
  reason?: string;
  status?: string;
  dispute_amount?: { value?: string; currency_code?: string };
  dispute_outcome?: {
    outcome_code?: string;
    amount_refunded?: { value?: string; currency_code?: string };
  };
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
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!clientId || !clientSecret || !webhookId) {
    const missing = [
      !clientId && "PAYPAL_CLIENT_ID",
      !clientSecret && "PAYPAL_CLIENT_SECRET",
      !webhookId && "PAYPAL_WEBHOOK_ID",
    ]
      .filter(Boolean)
      .join(", ");
    console.error(`[webhook/paypal] Missing required env vars: ${missing}`);
    return NextResponse.json(
      { error: `Missing env vars: ${missing}` },
      { status: 500 }
    );
  }

  const rawBody = await req.text();

  const transmissionId = req.headers.get("paypal-transmission-id");
  const transmissionTime = req.headers.get("paypal-transmission-time");
  const certUrl = req.headers.get("paypal-cert-url");
  const authAlgo = req.headers.get("paypal-auth-algo");
  const transmissionSig = req.headers.get("paypal-transmission-sig");

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
    console.error(
      `[webhook/paypal] Missing required PayPal webhook headers: ${missing}`
    );
    return NextResponse.json(
      { error: `Missing headers: ${missing}` },
      { status: 400 }
    );
  }

  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PayPalWebhookEvent;
  } catch (err) {
    console.error("[webhook/paypal] Failed to parse webhook body as JSON:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Obtain OAuth token then verify the signature with PayPal's API.
  let accessToken: string;
  try {
    accessToken = await getOAuthToken(clientId, clientSecret);
  } catch (err) {
    console.error("[webhook/paypal] Failed to obtain OAuth token:", err);
    return NextResponse.json(
      { error: "Signature verification failed" },
      { status: 400 }
    );
  }

  try {
    await verifySignature({
      accessToken,
      authAlgo,
      certUrl,
      transmissionId,
      transmissionSig,
      transmissionTime,
      webhookId,
      event,
    });
  } catch (err) {
    console.error("[webhook/paypal] Signature verification failed:", err);
    return NextResponse.json(
      { error: "Signature verification failed" },
      { status: 400 }
    );
  }

  console.error(
    `[webhook/paypal] Verified event type="${event.event_type}" id="${event.id}" ` +
      `create_time="${event.create_time ?? "unknown"}"`
  );

  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      return handleCaptureCompleted(event);

    case "PAYMENT.CAPTURE.DENIED":
      return handleCaptureDenied(event);

    case "PAYMENT.CAPTURE.REVERSED":
      return handleCaptureReversed(event);

    case "CUSTOMER.DISPUTE.CREATED":
      handleDisputeCreated(event);
      return NextResponse.json({ received: true }, { status: 200 });

    case "CUSTOMER.DISPUTE.RESOLVED":
      handleDisputeResolved(event);
      return NextResponse.json({ received: true }, { status: 200 });

    default:
      console.error(
        `[webhook/paypal] Unhandled event type="${event.event_type}" id="${event.id}". ` +
          `No action taken.`
      );
      return NextResponse.json({ received: true }, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// OAuth + signature verification
// ---------------------------------------------------------------------------

async function getOAuthToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(
      `PayPal OAuth token request failed: HTTP ${res.status} ${res.statusText}. Body: ${body}`
    );
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function verifySignature(params: {
  accessToken: string;
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  event: PayPalWebhookEvent;
}): Promise<void> {
  const {
    accessToken,
    authAlgo,
    certUrl,
    transmissionId,
    transmissionSig,
    transmissionTime,
    webhookId,
    event,
  } = params;

  const res = await fetch(
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
        webhook_event: event,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(
      `Verification API returned HTTP ${res.status} ${res.statusText}. Body: ${body}`
    );
  }

  const result = (await res.json()) as VerifyWebhookSignatureResponse;
  if (result.verification_status !== "SUCCESS") {
    throw new Error(
      `PayPal returned verification_status="${result.verification_status}" ` +
        `for event id="${event.id}" type="${event.event_type}" ` +
        `transmission_id="${transmissionId}". ` +
        `Possible replay attack or misconfigured PAYPAL_WEBHOOK_ID.`
    );
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCaptureCompleted(
  event: PayPalWebhookEvent
): Promise<NextResponse> {
  const capture = event.resource as PayPalCaptureResource;
  const captureId = capture.id ?? "unknown";
  const amountValue = capture.amount?.value ?? "unknown";
  const amountCurrency = capture.amount?.currency_code ?? "USD";
  const sellerProtection = capture.seller_protection?.status ?? "unknown";

  console.error(
    `[webhook/paypal] PAYMENT.CAPTURE.COMPLETED: ` +
      `capture_id="${captureId}" ` +
      `amount="${amountValue} ${amountCurrency}" ` +
      `seller_protection="${sellerProtection}" ` +
      `event_id="${event.id}". ` +
      `Updating audit log to "confirmed".`
  );

  const supabase = getAdminClient();
  const { error } = await supabase
    .from("audit_logs")
    .update({ status: "confirmed" })
    .eq("transaction_id", captureId);

  if (error) {
    console.error(
      `[webhook/paypal] DB update failed for PAYMENT.CAPTURE.COMPLETED ` +
        `capture_id="${captureId}":`,
      error
    );
    return NextResponse.json({ error: "Database update failed" }, { status: 500 });
  }

  console.error(
    `[webhook/paypal] PAYMENT.CAPTURE.COMPLETED: audit log updated to "confirmed" for ` +
      `capture_id="${captureId}".`
  );
  return NextResponse.json({ received: true }, { status: 200 });
}

async function handleCaptureDenied(
  event: PayPalWebhookEvent
): Promise<NextResponse> {
  const capture = event.resource as PayPalCaptureResource;
  const captureId = capture.id ?? "unknown";
  const amountValue = capture.amount?.value ?? "unknown";
  const amountCurrency = capture.amount?.currency_code ?? "USD";

  console.error(
    `[webhook/paypal] PAYMENT.CAPTURE.DENIED: ` +
      `capture_id="${captureId}" ` +
      `amount="${amountValue} ${amountCurrency}" ` +
      `event_id="${event.id}" ` +
      `summary="${event.summary ?? "no summary"}". ` +
      `SUPPORT: Look up this capture in the PayPal dashboard to identify the decline reason. ` +
      `Updating audit log to "failed".`
  );

  const supabase = getAdminClient();
  const { error } = await supabase
    .from("audit_logs")
    .update({ status: "failed" })
    .eq("transaction_id", captureId);

  if (error) {
    console.error(
      `[webhook/paypal] DB update failed for PAYMENT.CAPTURE.DENIED ` +
        `capture_id="${captureId}":`,
      error
    );
    return NextResponse.json({ error: "Database update failed" }, { status: 500 });
  }

  console.error(
    `[webhook/paypal] PAYMENT.CAPTURE.DENIED: audit log updated to "failed" for ` +
      `capture_id="${captureId}". ` +
      `The user should be notified that their payment method was declined and ` +
      `prompted to update it in the Spendex Pay dashboard.`
  );
  return NextResponse.json({ received: true }, { status: 200 });
}

async function handleCaptureReversed(
  event: PayPalWebhookEvent
): Promise<NextResponse> {
  const capture = event.resource as PayPalCaptureResource;
  const captureId = capture.id ?? "unknown";
  const amountValue = capture.amount?.value ?? "unknown";
  const amountCurrency = capture.amount?.currency_code ?? "USD";
  const captureStatus = capture.status ?? "unknown";
  const invoiceId = capture.invoice_id ?? "none";
  const customId = capture.custom_id ?? "none";

  console.error(
    `[webhook/paypal] PAYMENT.CAPTURE.REVERSED: ` +
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

  const supabase = getAdminClient();
  const { error } = await supabase
    .from("audit_logs")
    .update({ status: "reversed" })
    .eq("transaction_id", captureId);

  if (error) {
    console.error(
      `[webhook/paypal] DB update failed for PAYMENT.CAPTURE.REVERSED ` +
        `capture_id="${captureId}":`,
      error
    );
    return NextResponse.json({ error: "Database update failed" }, { status: 500 });
  }

  console.error(
    `[webhook/paypal] PAYMENT.CAPTURE.REVERSED: audit log updated to "reversed" for ` +
      `capture_id="${captureId}". ` +
      `SUPPORT: This reversal was initiated by PayPal, not the customer. ` +
      `Review the PayPal dashboard for the full reversal reason and determine ` +
      `whether the associated Spendex service delivery needs to be cancelled or rolled back.`
  );
  return NextResponse.json({ received: true }, { status: 200 });
}

function handleDisputeCreated(event: PayPalWebhookEvent): void {
  const dispute = event.resource as PayPalDisputeResource;

  const disputeId = dispute.dispute_id ?? "unknown";
  const reason = dispute.reason ?? "unknown";
  const status = dispute.status ?? "unknown";
  const amountValue = dispute.dispute_amount?.value ?? "unknown";
  const amountCurrency = dispute.dispute_amount?.currency_code ?? "USD";
  const createTime = dispute.create_time ?? "unknown";

  const firstTx = dispute.disputed_transactions?.[0];
  const buyerTransactionId = firstTx?.buyer_transaction_id ?? "unknown";
  const sellerTransactionId = firstTx?.seller_transaction_id ?? "unknown";
  const sellerEmail = firstTx?.seller?.email ?? "unknown";
  const merchantId = firstTx?.seller?.merchant_id ?? "unknown";

  const resolutionLink =
    dispute.links?.find((l) => l.rel === "appeal" || l.rel === "self")?.href ??
    "https://www.paypal.com/resolutioncenter";

  console.error(
    `[webhook/paypal] CRITICAL — CUSTOMER.DISPUTE.CREATED: ` +
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

function handleDisputeResolved(event: PayPalWebhookEvent): void {
  const dispute = event.resource as PayPalDisputeResource;

  const disputeId = dispute.dispute_id ?? "unknown";
  const status = dispute.status ?? "unknown";
  const reason = dispute.reason ?? "unknown";
  const outcomeCode = dispute.dispute_outcome?.outcome_code ?? "unknown";
  const refundedValue = dispute.dispute_outcome?.amount_refunded?.value;
  const refundedCurrency =
    dispute.dispute_outcome?.amount_refunded?.currency_code ?? "USD";
  const updateTime = dispute.update_time ?? "unknown";

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

  const sellerTransactionId =
    dispute.disputed_transactions?.[0]?.seller_transaction_id ?? "unknown";

  console.error(
    `[webhook/paypal] CUSTOMER.DISPUTE.RESOLVED: ` +
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
