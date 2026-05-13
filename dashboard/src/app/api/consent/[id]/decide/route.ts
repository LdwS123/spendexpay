/**
 * GET /api/consent/[id]/decide?option=<option>&token=<hmac>
 *
 * One-click consent decision endpoint hit from the email buttons. We do not
 * require the user to be logged in — the link itself is the authorisation,
 * via an HMAC token derived from MCP_TOKEN_SALT. The user clicked a button
 * in their own inbox; if they don't have inbox access the link is unusable
 * anyway.
 *
 * Why GET and not POST: email clients can't POST. Some mail providers
 * pre-fetch links to scan for malware, which could "click" a button before
 * the user does. Two mitigations are in place:
 *   - The token is single-purpose: only this exact (consent_id, option)
 *     combination, signed by MCP_TOKEN_SALT, validates. A scanner that
 *     opens a different option link will still be a real decision.
 *   - The status transition `pending → approved/declined` is one-shot. A
 *     pre-fetched approve link still records the decision; for V1 we
 *     accept this. If false-decisions become a problem we can add a
 *     "click to confirm" interstitial page that requires a second HTTP
 *     request via JavaScript.
 *
 * The response is plain HTML — no JSON, no auth cookies. We render success,
 * already-decided, and error states all server-side.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { verifyConsentDecisionToken } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Supabase admin client
// ---------------------------------------------------------------------------

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "[consent/decide] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set."
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ConsentRequestRow {
  id: string;
  user_id: string;
  status: string | null;
  options: string[] | null;
  decision: string | null;
}

// ---------------------------------------------------------------------------
// HTML rendering helpers — kept inline so we don't pull in React server runtime
// ---------------------------------------------------------------------------

const BG_NAVY = "#0D0F14";
const ACCENT_TEAL = "#6D5BFF";
const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(opts: {
  title: string;
  heading: string;
  body: string;
  accent?: "success" | "warning" | "error";
}): string {
  const accentColor =
    opts.accent === "error"
      ? "#dc2626"
      : opts.accent === "warning"
        ? "#d97706"
        : ACCENT_TEAL;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(opts.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:${FONT_STACK};color:#0f172a;">
    <div style="max-width:560px;margin:64px auto;padding:0 16px;">
      <div style="background:#ffffff;border-radius:14px;box-shadow:0 4px 24px rgba(7,13,24,0.08);overflow:hidden;">
        <div style="background:${BG_NAVY};padding:20px 28px;color:#ffffff;font-weight:600;letter-spacing:0.2px;">
          Spendex <span style="color:${ACCENT_TEAL};">Pay</span>
        </div>
        <div style="padding:32px 28px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:${accentColor};">${escapeHtml(opts.heading)}</h1>
          <div style="font-size:15px;line-height:1.6;color:#0f172a;">${opts.body}</div>
        </div>
      </div>
      <p style="margin:16px 0 0;text-align:center;font-size:12px;color:#64748b;">
        Spendex Pay — autonomous agent payments
      </p>
    </div>
  </body>
</html>`;
}

function htmlResponse(html: string, status = 200): NextResponse {
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: consentId } = await ctx.params;
  const url = new URL(req.url);
  const option = url.searchParams.get("option") ?? "";
  const token = url.searchParams.get("token") ?? "";

  if (!consentId || !option || !token) {
    return htmlResponse(
      renderPage({
        title: "Invalid link",
        heading: "Invalid or expired link",
        body: "<p>This consent link is missing required parameters. If you arrived here from an email, please check that the link wasn't broken by your mail client.</p>",
        accent: "error",
      }),
      400
    );
  }

  // 1. Verify HMAC.
  if (!verifyConsentDecisionToken(consentId, option, token)) {
    return htmlResponse(
      renderPage({
        title: "Invalid link",
        heading: "Invalid or expired link",
        body: "<p>We couldn't verify this consent link. It may have been tampered with, or the signing secret has rotated. Open your Spendex Pay dashboard to decide manually.</p>",
        accent: "error",
      }),
      403
    );
  }

  // 2. Load the consent row.
  let admin: SupabaseClient;
  try {
    admin = getSupabaseAdmin();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[consent/decide] ${message}`);
    return htmlResponse(
      renderPage({
        title: "Service unavailable",
        heading: "Service unavailable",
        body: "<p>We hit a configuration error on our side. Please try again from the dashboard.</p>",
        accent: "error",
      }),
      500
    );
  }

  const { data: consent, error: loadErr } = await admin
    .from("consent_requests")
    .select("id, user_id, status, options, decision")
    .eq("id", consentId)
    .maybeSingle<ConsentRequestRow>();

  if (loadErr) {
    console.error(
      `[consent/decide] Failed to load consent ${consentId}: ${loadErr.message}`
    );
    return htmlResponse(
      renderPage({
        title: "Error",
        heading: "Something went wrong",
        body: "<p>We couldn't load this consent request. Please open the dashboard and decide there.</p>",
        accent: "error",
      }),
      500
    );
  }
  if (!consent) {
    return htmlResponse(
      renderPage({
        title: "Not found",
        heading: "Consent request not found",
        body: "<p>This consent request may have expired or been deleted. Open the dashboard for a current list.</p>",
        accent: "error",
      }),
      404
    );
  }

  // 3. Already decided?
  if (consent.status && consent.status !== "pending") {
    const previousChoice = consent.decision ?? consent.status;
    return htmlResponse(
      renderPage({
        title: "Already decided",
        heading: "Already decided",
        body: `<p>This consent request was already <strong>${escapeHtml(consent.status)}</strong>.</p><p style="color:#64748b;">Decision on file: <strong>${escapeHtml(previousChoice)}</strong>.</p>`,
        accent: "warning",
      }),
      200
    );
  }

  // 4. Option allowed?
  const allowedOptions = Array.isArray(consent.options) ? consent.options : [];
  if (allowedOptions.length > 0 && !allowedOptions.includes(option)) {
    return htmlResponse(
      renderPage({
        title: "Invalid option",
        heading: "Invalid option",
        body: `<p>The option <code>${escapeHtml(option)}</code> isn't valid for this consent request.</p>`,
        accent: "error",
      }),
      400
    );
  }

  // 5. Record the decision. Use the WHERE status='pending' filter so two
  //    concurrent clicks (e.g. user clicks Approve in email and Approve in
  //    Telegram at the same moment) can't both succeed.
  const newStatus = option === "decline" ? "declined" : "approved";
  const { data: updated, error: updErr } = await admin
    .from("consent_requests")
    .update({
      status: newStatus,
      decision: option,
      decision_made_at: new Date().toISOString(),
    })
    .eq("id", consentId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (updErr) {
    console.error(
      `[consent/decide] Failed to update consent ${consentId}: ${updErr.message}`
    );
    return htmlResponse(
      renderPage({
        title: "Error",
        heading: "Couldn't record your decision",
        body: "<p>Our database returned an error. Please try again from the dashboard.</p>",
        accent: "error",
      }),
      500
    );
  }

  if (!updated) {
    // Someone else won the race — re-read to show the user the current state.
    const { data: fresh } = await admin
      .from("consent_requests")
      .select("status, decision")
      .eq("id", consentId)
      .maybeSingle<{ status: string | null; decision: string | null }>();
    return htmlResponse(
      renderPage({
        title: "Already decided",
        heading: "Already decided",
        body: `<p>Looks like this consent was decided in another channel just now.</p><p style="color:#64748b;">Current status: <strong>${escapeHtml(fresh?.status ?? "unknown")}</strong>${fresh?.decision ? ` (${escapeHtml(fresh.decision)})` : ""}.</p>`,
        accent: "warning",
      }),
      200
    );
  }

  console.error(
    `[consent/decide] Consent ${consentId} → ${newStatus} (option=${option}) via email link.`
  );

  const successBody =
    newStatus === "approved"
      ? `<p>Your decision: <strong>${escapeHtml(option)}</strong>.</p><p>Your agent will proceed. You can close this tab.</p>`
      : `<p>You declined this consent request.</p><p>Your agent has been stopped from continuing this action. You can close this tab.</p>`;

  return htmlResponse(
    renderPage({
      title: newStatus === "approved" ? "Approved" : "Declined",
      heading:
        newStatus === "approved" ? "✓ Consent recorded" : "✓ Decision recorded",
      body: successBody,
      accent: newStatus === "approved" ? "success" : "warning",
    }),
    200
  );
}
