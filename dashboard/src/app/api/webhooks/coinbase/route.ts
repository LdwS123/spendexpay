import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type CoinbaseEventType =
  | "charge:created"
  | "charge:confirmed"
  | "charge:failed"
  | "charge:delayed"
  | "charge:pending"
  | "charge:resolved";

interface CoinbaseWebhookBody {
  event: {
    id: string;
    type: CoinbaseEventType;
    data: {
      id: string;
      code: string;
    };
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-cc-webhook-signature");

  if (!signature) {
    console.error("[webhook/coinbase] Missing x-cc-webhook-signature header");
    return NextResponse.json(
      { error: "Missing x-cc-webhook-signature header" },
      { status: 400 }
    );
  }

  const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      "[webhook/coinbase] COINBASE_COMMERCE_WEBHOOK_SECRET is not set. Cannot verify webhook signature."
    );
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signature, "utf8");

  // timingSafeEqual requires identical lengths; a length mismatch itself leaks no info but we must reject.
  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    console.error("[webhook/coinbase] Signature verification failed");
    return NextResponse.json(
      { error: "Invalid signature" },
      { status: 400 }
    );
  }

  let body: CoinbaseWebhookBody;
  try {
    body = JSON.parse(rawBody) as CoinbaseWebhookBody;
  } catch (err) {
    console.error("[webhook/coinbase] Failed to parse body as JSON:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { event } = body;

  if (!event?.type || !event?.data?.id) {
    console.error(
      "[webhook/coinbase] Payload missing required fields (event.type or event.data.id)"
    );
    return NextResponse.json(
      { error: "Malformed webhook payload" },
      { status: 400 }
    );
  }

  const chargeId = event.data.id;

  switch (event.type) {
    case "charge:confirmed": {
      const { error } = await getAdminClient()
        .from("audit_logs")
        .update({ status: "confirmed" })
        .eq("transaction_id", chargeId);
      if (error) {
        console.error(
          `[webhook/coinbase] DB update failed for charge ${chargeId} (charge:confirmed):`,
          error
        );
        return NextResponse.json({ error: "DB update failed" }, { status: 500 });
      }
      console.error(
        `[webhook/coinbase] charge:confirmed — audit_log updated to confirmed for charge ${chargeId}`
      );
      break;
    }

    case "charge:failed": {
      const { error } = await getAdminClient()
        .from("audit_logs")
        .update({ status: "failed" })
        .eq("transaction_id", chargeId);
      if (error) {
        console.error(
          `[webhook/coinbase] DB update failed for charge ${chargeId} (charge:failed):`,
          error
        );
        return NextResponse.json({ error: "DB update failed" }, { status: 500 });
      }
      console.error(
        `[webhook/coinbase] charge:failed — audit_log updated to failed for charge ${chargeId}`
      );
      break;
    }

    case "charge:pending": {
      const { error } = await getAdminClient()
        .from("audit_logs")
        .update({ status: "payment_pending" })
        .eq("transaction_id", chargeId);
      if (error) {
        console.error(
          `[webhook/coinbase] DB update failed for charge ${chargeId} (charge:pending):`,
          error
        );
        return NextResponse.json({ error: "DB update failed" }, { status: 500 });
      }
      console.error(
        `[webhook/coinbase] charge:pending — on-chain transfer detected, not yet confirmed for charge ${chargeId}`
      );
      break;
    }

    case "charge:delayed": {
      // Payment arrived after the charge expiry window. Coinbase may attempt a refund.
      // This charge cannot be used to fulfill the order — manual reconciliation is required.
      console.error(
        `[webhook/coinbase] DELAYED PAYMENT — charge ${chargeId} (code: ${event.data.code}) received payment ` +
        `after expiry. Funds may need manual reconciliation. Do not fulfill this order automatically.`
      );
      const { error } = await getAdminClient()
        .from("audit_logs")
        .update({ status: "payment_delayed" })
        .eq("transaction_id", chargeId);
      if (error) {
        console.error(
          `[webhook/coinbase] DB update failed for charge ${chargeId} (charge:delayed):`,
          error
        );
        return NextResponse.json({ error: "DB update failed" }, { status: 500 });
      }
      break;
    }

    case "charge:created":
    case "charge:resolved":
      console.error(
        `[webhook/coinbase] ${event.type} received for charge ${chargeId} — no DB update needed`
      );
      break;

    default:
      console.error(
        `[webhook/coinbase] Unknown event type "${event.type}" for charge ${chargeId} — ignoring`
      );
      break;
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
