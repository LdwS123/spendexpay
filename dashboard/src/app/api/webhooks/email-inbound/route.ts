/**
 * Inbound email webhook handler.
 *
 * Spendex provisions per-account email aliases like
 *   signup-abc123@mail.spendexai.com
 * for the agent to use when signing up for downstream services (Vercel,
 * Modal, Railway, …). The MX records for `mail.spendexai.com` are pointed
 * at Resend's inbound mail servers, which POST every received message to
 * this endpoint. Once parsed, the email — including any verification link
 * or code — is persisted into `inbound_emails` so an agent can poll for
 * the message it's waiting on.
 *
 * Security model:
 *   - Signature verification (Svix / Resend `resend-signature` header).
 *     A missing or invalid signature is a hard 401: do not even open the
 *     payload. The shared secret is `RESEND_WEBHOOK_SECRET`.
 *   - DEV_MODE bypasses the signature check (no real webhook in dev).
 *   - The `to` address must end in `@mail.spendexai.com` — anything else
 *     is rejected with 400 to surface misconfigured forwarding rules.
 *   - If the `to` alias does not match any provisioned `managed_accounts`
 *     row we still return 200 (so Resend never retries) but log a warning.
 *     Resend retries non-2xx for hours; replaying a verified-but-orphan
 *     payload over and over is pure noise.
 *
 * Latency:
 *   The whole handler is single-write: one Supabase select on
 *   `managed_accounts`, then one insert into `inbound_emails`. We never
 *   await external network calls inside the request. Resend gives us a
 *   30-second window, but typical execution stays under ~150 ms.
 *
 * Logging:
 *   All diagnostics go to `console.error` (stderr). We keep the convention
 *   shared with the MCP server even though Next.js does not multiplex
 *   stdio for protocol framing — it makes grepping logs consistent.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";

// Signature verification needs the exact bytes that were sent over the wire.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INBOUND_DOMAIN = "mail.spendexai.com";

// First absolute https URL in the body. Most verification emails embed
// the click-through link as the very first https URL; if not, the agent
// still has the full body to fall back to.
const FIRST_HTTPS_URL = /https:\/\/[^\s<>"')]+/;

// 4–8 contiguous digits, optionally surrounded by separators. Verification
// codes are conventionally exactly that — Vercel uses 6, Modal uses 6,
// Stripe uses 6, others vary. We bound the upper end to avoid collecting
// invoice IDs, order numbers, etc. that happen to be longer.
const VERIFICATION_CODE = /(?<![0-9])([0-9]{4,8})(?![0-9])/;

// ---------------------------------------------------------------------------
// Supabase admin client (service-role; bypasses RLS).
//
// Construction is lazy so a missing env var only crashes the actual request
// — not the route module's initial import (which would 500 every endpoint
// in the bundle that shares this file's chunk).
// ---------------------------------------------------------------------------

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "[webhook/email-inbound] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set."
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
// Env helpers — never cached so flips to EMERGENCY_STOP / SPENDEX_DEV take
// effect on the next request.
// ---------------------------------------------------------------------------

function isDevMode(): boolean {
  return process.env.SPENDEX_DEV === "true";
}

// ---------------------------------------------------------------------------
// Wire-format types
// ---------------------------------------------------------------------------

interface InboundEmailAttachment {
  filename?: string;
  content_type?: string;
  size?: number;
}

interface InboundEmailPayload {
  from: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: InboundEmailAttachment[];
  received_at?: string;
}

interface ManagedAccountRow {
  id: string;
  user_id: string;
  service: string | null;
  email_alias: string;
}

// ---------------------------------------------------------------------------
// Signature verification
//
// Resend (and Svix-compatible providers in general) signs the payload as:
//   sig = HMAC_SHA256(secret, `${msg_id}.${timestamp}.${body}`)
// then base64-encodes it and ships it in `resend-signature` (or
// `svix-signature`) as `v1,<b64>` with potentially multiple signatures
// comma-separated. We accept any of the comma-separated signatures.
//
// We also accept a raw HMAC over the body alone (Resend's "Send-Test"
// shape). Tooling is inconsistent across providers, so trying both — but
// only with timing-safe compare — is strictly better than either alone.
// ---------------------------------------------------------------------------

function verifySignature(
  body: string,
  headers: Headers,
  secret: string
): boolean {
  const headerNames = [
    "resend-signature",
    "svix-signature",
    "webhook-signature",
  ];
  let header: string | null = null;
  for (const name of headerNames) {
    const value = headers.get(name);
    if (value) {
      header = value;
      break;
    }
  }
  if (!header) return false;

  const msgId =
    headers.get("svix-id") ?? headers.get("webhook-id") ?? "";
  const timestamp =
    headers.get("svix-timestamp") ??
    headers.get("webhook-timestamp") ??
    "";

  // Strip a `whsec_` prefix if present — Svix-style secrets are base64
  // encoded under that prefix; raw secrets are passed through as-is.
  const secretMaterial = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");

  // Candidate signed payloads. The first form is the Svix canonical
  // format; the second covers providers that sign only the body.
  const signedPayloads: string[] = [];
  if (msgId && timestamp) {
    signedPayloads.push(`${msgId}.${timestamp}.${body}`);
  }
  signedPayloads.push(body);

  const expectedSignatures = signedPayloads.map((payload) =>
    createHmac("sha256", secretMaterial).update(payload).digest("base64")
  );

  // Split the header into the individual v1=… entries Svix produces.
  const candidates = header
    .split(/[\s,]+/)
    .map((entry) => {
      const idx = entry.indexOf(",");
      // Two possible shapes here:
      //   v1,<sig>      (entry already split by outer comma)
      //   v1=<sig>      (legacy / alt form)
      if (idx === -1) {
        const eq = entry.indexOf("=");
        return eq === -1 ? entry : entry.slice(eq + 1);
      }
      return entry.slice(idx + 1);
    })
    .filter((s) => s.length > 0);

  if (candidates.length === 0) return false;

  for (const candidate of candidates) {
    let candidateBuf: Buffer;
    try {
      candidateBuf = Buffer.from(candidate, "base64");
    } catch {
      continue;
    }
    for (const expected of expectedSignatures) {
      const expectedBuf = Buffer.from(expected, "base64");
      if (
        candidateBuf.length === expectedBuf.length &&
        timingSafeEqual(candidateBuf, expectedBuf)
      ) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function parsePayload(raw: unknown): InboundEmailPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // Some providers wrap the message inside { data: { … } } (Svix event
  // shape). Unwrap once if we see that.
  const candidate =
    typeof obj.data === "object" && obj.data !== null
      ? (obj.data as Record<string, unknown>)
      : obj;

  const from = typeof candidate.from === "string" ? candidate.from : null;
  const to = typeof candidate.to === "string" ? candidate.to : null;
  if (!from || !to) return null;

  const subject =
    typeof candidate.subject === "string" ? candidate.subject : undefined;
  const text = typeof candidate.text === "string" ? candidate.text : undefined;
  const html = typeof candidate.html === "string" ? candidate.html : undefined;
  const receivedAt =
    typeof candidate.received_at === "string"
      ? candidate.received_at
      : typeof candidate.receivedAt === "string"
      ? candidate.receivedAt
      : undefined;

  const attachmentsRaw = candidate.attachments;
  const attachments: InboundEmailAttachment[] | undefined = Array.isArray(
    attachmentsRaw
  )
    ? attachmentsRaw
        .filter(
          (a): a is Record<string, unknown> =>
            typeof a === "object" && a !== null
        )
        .map((a) => ({
          filename: typeof a.filename === "string" ? a.filename : undefined,
          content_type:
            typeof a.content_type === "string" ? a.content_type : undefined,
          size: typeof a.size === "number" ? a.size : undefined,
        }))
    : undefined;

  return {
    from,
    to,
    subject,
    text,
    html,
    attachments,
    received_at: receivedAt,
  };
}

/**
 * Extract the local part (before `@`) of an inbound address, verifying that
 * the domain is exactly `mail.spendexai.com`. RFC 5322 allows multiple
 * addresses in a `To` header; we take the first one whose domain matches.
 */
function extractAlias(to: string): string | null {
  const candidates = to
    .split(",")
    .map((s) => s.trim())
    .map((s) => {
      // Strip "Display Name <addr@host>" wrappers if present.
      const lt = s.indexOf("<");
      const gt = s.indexOf(">");
      if (lt !== -1 && gt !== -1 && gt > lt) {
        return s.slice(lt + 1, gt).trim();
      }
      return s;
    })
    .filter((s) => s.length > 0);

  for (const addr of candidates) {
    const at = addr.lastIndexOf("@");
    if (at === -1) continue;
    const domain = addr.slice(at + 1).toLowerCase();
    if (domain === INBOUND_DOMAIN) {
      // Lowercase the alias for stable lookups. Email local parts are
      // technically case-sensitive per RFC 5321, but every mail server in
      // production treats them case-insensitively, and we control the
      // alias generator anyway.
      return addr.toLowerCase();
    }
  }
  return null;
}

function extractVerificationLink(payload: InboundEmailPayload): string | null {
  const text = payload.text ?? "";
  const textMatch = text.match(FIRST_HTTPS_URL);
  if (textMatch) return textMatch[0];

  const html = payload.html ?? "";
  const htmlMatch = html.match(FIRST_HTTPS_URL);
  if (htmlMatch) return htmlMatch[0];

  return null;
}

function extractVerificationCode(payload: InboundEmailPayload): string | null {
  const text = payload.text ?? "";
  const m = text.match(VERIFICATION_CODE);
  if (m) return m[1];

  const html = payload.html ?? "";
  // Strip HTML tags before scanning so codes inside e.g. <strong> don't
  // sit adjacent to extra digits from inline styles.
  const stripped = html.replace(/<[^>]+>/g, " ");
  const htmlMatch = stripped.match(VERIFICATION_CODE);
  return htmlMatch ? htmlMatch[1] : null;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Read the raw body once — we need the exact bytes for signature
  // verification, and we re-parse it as JSON afterwards.
  const body = await req.text();

  // ---------- Signature verification ----------
  if (!isDevMode()) {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      console.error(
        "[webhook/email-inbound] RESEND_WEBHOOK_SECRET is not set. " +
          "Refusing to process inbound email without signature verification."
      );
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 }
      );
    }

    const ok = verifySignature(body, req.headers, secret);
    if (!ok) {
      console.error(
        "[webhook/email-inbound] Rejected request: missing or invalid signature."
      );
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      );
    }
  } else {
    console.error(
      "[webhook/email-inbound] DEV MODE — skipping signature verification."
    );
  }

  // ---------- Parse payload ----------
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[webhook/email-inbound] Failed to parse JSON body: ${message}.`
    );
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  const payload = parsePayload(parsedJson);
  if (!payload) {
    console.error(
      "[webhook/email-inbound] Payload missing required `from`/`to` fields."
    );
    return NextResponse.json(
      { error: "Missing required fields: from, to" },
      { status: 400 }
    );
  }

  // ---------- Domain check ----------
  const alias = extractAlias(payload.to);
  if (!alias) {
    console.error(
      `[webhook/email-inbound] Rejected: "to" does not contain an ` +
        `@${INBOUND_DOMAIN} address (raw="${payload.to}").`
    );
    return NextResponse.json(
      { error: `Recipient must be an @${INBOUND_DOMAIN} address` },
      { status: 400 }
    );
  }

  // ---------- Match alias to managed_account ----------
  let supabase: SupabaseClient;
  try {
    supabase = getSupabaseAdmin();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[webhook/email-inbound] ${message}`);
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }

  let managedAccount: ManagedAccountRow | null = null;
  {
    const { data, error } = await supabase
      .from("managed_accounts")
      .select("id, user_id, service, email_alias")
      .eq("email_alias", alias)
      .maybeSingle();

    if (error) {
      console.error(
        `[webhook/email-inbound] Supabase lookup failed for alias="${alias}": ` +
          `${error.message} (code: ${error.code}).`
      );
      // 500 would prompt Resend to retry — which is correct for a
      // transient DB blip. Use 500 here rather than 200.
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }
    managedAccount = (data as ManagedAccountRow | null) ?? null;
  }

  if (!managedAccount) {
    console.error(
      `[webhook/email-inbound] WARNING: no managed_account found for ` +
        `alias="${alias}" from="${payload.from}". Dropping (returning 200 so ` +
        `Resend does not retry).`
    );
    return NextResponse.json(
      { success: true, dropped: true, reason: "alias_not_provisioned" },
      { status: 200 }
    );
  }

  // ---------- Extract verification artefacts ----------
  const verificationLink = extractVerificationLink(payload);
  const verificationCode = extractVerificationCode(payload);

  const receivedAtIso = payload.received_at ?? new Date().toISOString();

  // ---------- Insert ----------
  const { error: insertError } = await supabase
    .from("inbound_emails")
    .insert({
      email_alias: alias,
      managed_account_id: managedAccount.id,
      from_address: payload.from,
      subject: payload.subject ?? null,
      body_text: payload.text ?? null,
      body_html: payload.html ?? null,
      verification_link: verificationLink,
      verification_code: verificationCode,
      received_at: receivedAtIso,
      raw_payload: parsedJson as Record<string, unknown>,
    });

  if (insertError) {
    console.error(
      `[webhook/email-inbound] Failed to insert inbound_emails row for ` +
        `alias="${alias}" managed_account_id="${managedAccount.id}": ` +
        `${insertError.message} (code: ${insertError.code}).`
    );
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }

  console.error(
    `[webhook/email-inbound] Stored inbound email: alias="${alias}" ` +
      `managed_account_id="${managedAccount.id}" from="${payload.from}" ` +
      `subject="${payload.subject ?? ""}" ` +
      `link=${verificationLink ? "yes" : "no"} ` +
      `code=${verificationCode ? "yes" : "no"}.`
  );

  return NextResponse.json({ success: true }, { status: 200 });
}
