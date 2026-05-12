import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CircleTransferEvent {
  subscriptionId?: string;
  notificationType: string;
  version?: number;
  customAttributes?: { clientId?: string };
  transfer?: {
    id: string;
    state: "running" | "complete" | "failed";
    errorCode?: string | null;
  };
}

/**
 * Constant-time comparison of two hex strings.
 *
 * `timingSafeEqual` requires equal-length buffers — if we pass mismatched
 * lengths it throws synchronously, which would itself become a timing oracle
 * (throw vs. return). We do the length check first and short-circuit to
 * `false` before calling into the crypto routine.
 */
function safeHexEqual(expectedHex: string, providedHex: string): boolean {
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  const providedBuf = Buffer.from(providedHex, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // --------------------------------------------------------------------------
  // 1. Fail closed if the webhook secret is not configured. A misconfigured
  //    server must never accept unauthenticated webhook traffic — silently
  //    bypassing the signature check would let an attacker forge transfer
  //    completions and flip audit_logs rows to "confirmed".
  // --------------------------------------------------------------------------
  const webhookSecret = process.env.CIRCLE_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret === "" || webhookSecret === "PLACEHOLDER") {
    console.error(
      "[webhook/circle] CIRCLE_WEBHOOK_SECRET not configured — refusing all updates."
    );
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  // --------------------------------------------------------------------------
  // 2. Read the raw body BEFORE parsing. The HMAC must be computed over the
  //    exact bytes Circle signed; round-tripping through JSON.parse +
  //    JSON.stringify would reorder keys / normalise whitespace and break the
  //    signature.
  // --------------------------------------------------------------------------
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    console.error("[webhook/circle] Failed to read request body:", err);
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // --------------------------------------------------------------------------
  // 3. Verify the X-Circle-Signature header. Circle sends
  //    hmac_sha256(rawBody, webhookSecret) as a hex string.
  // --------------------------------------------------------------------------
  const providedSignature = req.headers.get("x-circle-signature") ?? "";
  if (!providedSignature) {
    console.error("[webhook/circle] Missing X-Circle-Signature header.");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  if (!safeHexEqual(expectedSignature, providedSignature)) {
    console.error("[webhook/circle] Rejected update: signature mismatch.");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --------------------------------------------------------------------------
  // 4. Only AFTER the signature passes do we parse the JSON. Parsing
  //    untrusted JSON is cheap but the principle stands: authenticate first,
  //    process second.
  // --------------------------------------------------------------------------
  let body: CircleTransferEvent;
  try {
    body = JSON.parse(rawBody) as CircleTransferEvent;
  } catch (err) {
    console.error("[webhook/circle] Failed to parse request body as JSON:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.notificationType) {
    console.error(
      "[webhook/circle] Payload missing required field: notificationType"
    );
    return NextResponse.json(
      { error: "Malformed webhook payload" },
      { status: 400 }
    );
  }

  if (body.notificationType !== "transfers") {
    console.error(
      `[webhook/circle] Received notificationType="${body.notificationType}" — no action needed`
    );
    return NextResponse.json({ received: true }, { status: 200 });
  }

  if (!body.transfer?.id) {
    console.error(
      "[webhook/circle] transfers event is missing transfer.id — cannot update audit log"
    );
    return NextResponse.json(
      { error: "Malformed transfers payload" },
      { status: 400 }
    );
  }

  const { transfer } = body;
  const transferId = transfer.id;

  if (transfer.state === "complete") {
    const { error } = await getAdminClient()
      .from("audit_logs")
      .update({ status: "confirmed" })
      .eq("transaction_id", transferId);

    if (error) {
      console.error(
        `[webhook/circle] DB update failed for transfer ${transferId} (state=complete):`,
        error
      );
      return NextResponse.json({ error: "DB update failed" }, { status: 500 });
    }

    console.error(
      `[webhook/circle] transfer complete — audit_log updated to "confirmed" for transfer ${transferId}`
    );
  } else if (transfer.state === "failed") {
    const { error } = await getAdminClient()
      .from("audit_logs")
      .update({ status: "failed" })
      .eq("transaction_id", transferId);

    if (error) {
      console.error(
        `[webhook/circle] DB update failed for transfer ${transferId} (state=failed):`,
        error
      );
      return NextResponse.json({ error: "DB update failed" }, { status: 500 });
    }

    console.error(
      `[webhook/circle] transfer failed — audit_log updated to "failed" for transfer ${transferId}` +
        (transfer.errorCode ? ` (errorCode: ${transfer.errorCode})` : "")
    );
  } else {
    console.error(
      `[webhook/circle] transfers event for transfer ${transferId} has state="${transfer.state}" — no action needed`
    );
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
