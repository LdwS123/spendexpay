/**
 * Inbound Twilio SMS webhook handler.
 *
 * When Spendex provisions a virtual phone number for a user, the Twilio
 * IncomingPhoneNumber resource is configured to POST every inbound SMS to
 * this endpoint as `application/x-www-form-urlencoded`. We verify the
 * `X-Twilio-Signature` header (HMAC-SHA1 over `${url}${sortedConcatParams}`,
 * key = TWILIO_AUTH_TOKEN), match the `To` number to a virtual_phones row,
 * extract a 4-8 digit verification code from the body, and insert a row
 * into `sms_messages`.
 *
 * The MCP `get_sms_code` tool then reads the most recent unconsumed row
 * for that user's active virtual phone and marks it consumed.
 *
 * Security model:
 *   - Twilio signature verification is mandatory in production. A missing
 *     or invalid signature returns 401 immediately — we don't even open
 *     the body. DEV mode skips this so local curl tests work.
 *   - If the `To` number does not match any provisioned `virtual_phones`
 *     row we return 200 + dropped (so Twilio doesn't retry forever).
 *
 * Logging:
 *   All diagnostics go to `console.error` (stderr). Same convention as the
 *   rest of the codebase.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";

// Twilio's signature is over the *exact* request bytes — must be dynamic.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// 4–8 contiguous digits, not preceded or followed by another digit. Matches
// the canonical verification-code shape every major service uses (Twilio's
// own Verify, AWS, Vercel, Modal, Amazon retail). Bounded at 8 so we don't
// snap up order numbers, ticket IDs, or phone-number-shaped substrings.
const VERIFICATION_CODE = /(?<!\d)(\d{4,8})(?!\d)/;

// ---------------------------------------------------------------------------
// Supabase admin client (service-role; bypasses RLS).
//
// Lazy so a missing env var only crashes the actual request, not the route
// module's initial import.
// ---------------------------------------------------------------------------

function getAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "[webhook/twilio-sms] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set."
    );
  }
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function isDevMode(): boolean {
  return process.env.SPENDEX_DEV === "true";
}

// ---------------------------------------------------------------------------
// Signature verification
//
// Twilio's algorithm (see twilio-node `validateRequest`):
//   1. Start with the full request URL (scheme + host + path + query).
//   2. Sort POST parameters lexicographically by key.
//   3. Concatenate `key + value` pairs (no delimiter) onto the URL string.
//   4. HMAC-SHA1 the result with the auth token as key.
//   5. Base64-encode the digest. Compare to the `X-Twilio-Signature` header
//      with a timing-safe equal.
//
// We accept both the `x-forwarded-*` shape (behind Vercel/Cloudflare) and the
// direct `req.url` shape (local dev). The webhook URL Twilio knows about must
// be configured to match — typically `https://app.spendexai.com/api/webhooks/twilio-sms`.
// ---------------------------------------------------------------------------

function resolveRequestUrl(req: NextRequest): string {
  // Honor x-forwarded-* if present so the URL matches the public hostname
  // Twilio actually called. Without this, behind a proxy we'd hash
  // "http://internal-host/api/webhooks/twilio-sms" while Twilio signed
  // "https://app.spendexai.com/api/webhooks/twilio-sms" — signatures never
  // match in that world.
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) {
    const { pathname, search } = new URL(req.url);
    return `${proto}://${host}${pathname}${search}`;
  }
  return req.url;
}

function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string,
  authToken: string
): boolean {
  const sortedKeys = Object.keys(params).sort();
  let payload = url;
  for (const key of sortedKeys) {
    payload += key + params[key];
  }

  const expected = createHmac("sha1", authToken).update(payload).digest("base64");

  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "base64");
    actualBuf = Buffer.from(signatureHeader, "base64");
  } catch {
    return false;
  }

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  // URLSearchParams handles `+ → space` and percent-decoding correctly,
  // matching what Twilio's signing algorithm expects on the verifier side.
  const usp = new URLSearchParams(body);
  for (const [key, value] of usp.entries()) {
    params[key] = value;
  }
  return params;
}

function extractCode(body: string): string | null {
  const m = body.match(VERIFICATION_CODE);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Wire-format types
// ---------------------------------------------------------------------------

interface VirtualPhoneRow {
  id: string;
  user_id: string;
  e164_number: string;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Twilio sends application/x-www-form-urlencoded. Read once as text so we
  // have the exact bytes for signature verification and form parsing.
  const body = await req.text();
  const params = parseFormBody(body);

  // ---------- Signature verification ----------
  if (!isDevMode()) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      console.error(
        "[webhook/twilio-sms] TWILIO_AUTH_TOKEN is not set. " +
          "Refusing to process inbound SMS without signature verification."
      );
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 }
      );
    }

    const signature = req.headers.get("x-twilio-signature");
    if (!signature) {
      console.error(
        "[webhook/twilio-sms] Rejected: missing X-Twilio-Signature header."
      );
      return NextResponse.json(
        { error: "Missing signature" },
        { status: 401 }
      );
    }

    const url = resolveRequestUrl(req);
    const ok = verifyTwilioSignature(url, params, signature, authToken);
    if (!ok) {
      console.error(
        `[webhook/twilio-sms] Rejected: invalid signature for url="${url}".`
      );
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      );
    }
  } else {
    console.error(
      "[webhook/twilio-sms] DEV MODE — skipping signature verification."
    );
  }

  // ---------- Required fields ----------
  const to = params["To"];
  const from = params["From"];
  const messageBody = params["Body"];

  if (!to || !from || messageBody === undefined) {
    console.error(
      `[webhook/twilio-sms] Payload missing required field(s): ` +
        `to=${to ? "yes" : "no"} from=${from ? "yes" : "no"} body=${
          messageBody !== undefined ? "yes" : "no"
        }.`
    );
    return NextResponse.json(
      { error: "Missing required fields: To, From, Body" },
      { status: 400 }
    );
  }

  // ---------- Match To-number to a virtual_phones row ----------
  let supabase: SupabaseClient;
  try {
    supabase = getAdminClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[webhook/twilio-sms] ${message}`);
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }

  let virtualPhone: VirtualPhoneRow | null = null;
  {
    const { data, error } = await supabase
      .from("virtual_phones")
      .select("id, user_id, e164_number")
      .eq("e164_number", to)
      .is("released_at", null)
      .maybeSingle();

    if (error) {
      console.error(
        `[webhook/twilio-sms] Supabase lookup failed for to="${to}": ` +
          `${error.message} (code: ${error.code}).`
      );
      // 500 prompts Twilio to retry, which is correct for a transient blip.
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }
    virtualPhone = (data as VirtualPhoneRow | null) ?? null;
  }

  if (!virtualPhone) {
    console.error(
      `[webhook/twilio-sms] WARNING: no active virtual_phones row for ` +
        `to="${to}" from="${from}". Dropping (returning 200 so Twilio does ` +
        `not retry).`
    );
    return NextResponse.json(
      { success: true, dropped: true, reason: "number_not_provisioned" },
      { status: 200 }
    );
  }

  // ---------- Extract code + insert ----------
  const extractedCode = extractCode(messageBody);

  const { error: insertError } = await supabase
    .from("sms_messages")
    .insert({
      virtual_phone_id: virtualPhone.id,
      from_number: from,
      body: messageBody,
      extracted_code: extractedCode,
    });

  if (insertError) {
    console.error(
      `[webhook/twilio-sms] Failed to insert sms_messages row for ` +
        `virtual_phone_id="${virtualPhone.id}" to="${to}": ` +
        `${insertError.message} (code: ${insertError.code}).`
    );
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }

  console.error(
    `[webhook/twilio-sms] Stored inbound SMS: to="${to}" from="${from}" ` +
      `virtual_phone_id="${virtualPhone.id}" code=${
        extractedCode ? "yes" : "no"
      }.`
  );

  // Twilio accepts an empty 200 (or TwiML). We use JSON for consistency
  // with the rest of our webhook handlers.
  return NextResponse.json({ success: true }, { status: 200 });
}
