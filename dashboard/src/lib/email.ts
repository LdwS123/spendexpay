/**
 * Email delivery via Resend.
 *
 * All sender functions are best-effort: they catch errors internally and log
 * via console.error. Email failures must never crash the caller because the
 * primary action (user signup, charge approval) has already succeeded.
 *
 * In development, RESEND_API_KEY is typically unset or left as a placeholder.
 * getResend() returns null in that case and the senders no-op.
 */

import { createHmac } from "node:crypto";
import { Resend } from "resend";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://spendexai.com";
const DASHBOARD_URL = `${APP_URL}/dashboard`;
const BG_NAVY = "#070d18";
const ACCENT_TEAL = "#00e5b4";
const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

let cachedClient: Resend | null = null;

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key || key.startsWith("re_PLACEHOLDER")) {
    return null;
  }
  if (!cachedClient) {
    cachedClient = new Resend(key);
  }
  return cachedClient;
}

function getFromAddress(): string {
  return process.env.RESEND_FROM_EMAIL ?? "Spendex Pay <hello@spendexai.com>";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface ShellOptions {
  preheader: string;
  bodyHtml: string;
}

function wrapEmail({ preheader, bodyHtml }: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Spendex Pay</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:${FONT_STACK};color:#0f172a;">
    <span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;font-size:1px;line-height:1px;color:#f4f5f7;">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(7,13,24,0.08);">
            <tr>
              <td style="background:${BG_NAVY};padding:28px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="font-family:${FONT_STACK};font-size:18px;font-weight:600;color:#ffffff;letter-spacing:0.2px;">
                      Spendex <span style="color:${ACCENT_TEAL};">Pay</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:#0f172a;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px;font-family:${FONT_STACK};font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;">
                You are receiving this because you have an active Spendex Pay account.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function primaryButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr>
      <td style="border-radius:10px;background:${BG_NAVY};">
        <a href="${href}" style="display:inline-block;padding:12px 22px;font-family:${FONT_STACK};font-size:14px;font-weight:600;color:${ACCENT_TEAL};text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

interface WelcomeEmailParams {
  to: string;
  displayName: string;
}

export async function sendWelcomeEmail(params: WelcomeEmailParams): Promise<void> {
  const client = getResend();
  if (!client) {
    console.error(
      `[email] Resend not configured — skipping welcome email to ${params.to}.`
    );
    return;
  }

  const name = params.displayName.trim() || "there";
  const safeName = escapeHtml(name);

  const body = `
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:${BG_NAVY};">Welcome to Spendex Pay, ${safeName}.</h1>
    <p style="margin:0 0 20px;">Your account is ready. Spendex Pay lets your coding agents pay for dev services automatically, without waking you up.</p>
    <h2 style="margin:24px 0 12px;font-size:16px;font-weight:600;color:${BG_NAVY};">Three steps to go live</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:6px 0;font-weight:600;color:${BG_NAVY};">1. Add a funding source</td>
      </tr>
      <tr>
        <td style="padding:0 0 12px;color:#475569;">Connect a card to fund your wallet. Your card stays in Stripe; we never see the number.</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-weight:600;color:${BG_NAVY};">2. Generate an MCP token</td>
      </tr>
      <tr>
        <td style="padding:0 0 12px;color:#475569;">Tokens scope what an agent can do and how much it can spend. Give one to each agent or workspace.</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-weight:600;color:${BG_NAVY};">3. Deploy from your agent</td>
      </tr>
      <tr>
        <td style="padding:0 0 4px;color:#475569;">Ask Claude Code (or Cursor, Windsurf, Codex) to ship something. Spendex Pay handles the bill.</td>
      </tr>
    </table>
    ${primaryButton(DASHBOARD_URL, "Open your dashboard")}
    <p style="margin:16px 0 0;color:#475569;">Questions? Just reply to this email — it lands in our inbox.</p>
  `;

  const html = wrapEmail({
    preheader: "Welcome to Spendex Pay — here is how to go live.",
    bodyHtml: body,
  });

  try {
    const { error } = await client.emails.send({
      from: getFromAddress(),
      to: params.to,
      subject: "Welcome to Spendex Pay 🎉",
      html,
    });
    if (error) {
      console.error(
        `[email] Resend returned error for welcome email to ${params.to}:`,
        error
      );
      return;
    }
    console.error(`[email] Welcome email sent to ${params.to}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[email] Failed to send welcome email to ${params.to}: ${message}`
    );
  }
}

interface ChargeNotificationParams {
  to: string;
  displayName: string;
  service: string;
  amountUsd: number;
  transactionId: string;
  deploymentUrl?: string;
}

function formatAmountEur(amountUsd: number): string {
  const safe = Number.isFinite(amountUsd) ? amountUsd : 0;
  return safe.toFixed(2);
}

export async function sendChargeNotification(
  params: ChargeNotificationParams
): Promise<void> {
  const client = getResend();
  if (!client) {
    console.error(
      `[email] Resend not configured — skipping charge notification to ${params.to}.`
    );
    return;
  }

  const amountStr = formatAmountEur(params.amountUsd);
  const safeName = escapeHtml(params.displayName.trim() || "there");
  const safeService = escapeHtml(params.service);
  const safeAmount = escapeHtml(amountStr);
  const transactionUrl = `${DASHBOARD_URL}/transactions/${encodeURIComponent(
    params.transactionId
  )}`;

  const deploymentBlock = params.deploymentUrl
    ? `<tr>
        <td style="padding:8px 0;color:#475569;">Deployment</td>
        <td style="padding:8px 0;text-align:right;">
          <a href="${escapeHtml(params.deploymentUrl)}" style="color:${ACCENT_TEAL};text-decoration:none;font-weight:600;">View deployment</a>
        </td>
      </tr>`
    : "";

  const body = `
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:${BG_NAVY};">Charge approved</h1>
    <p style="margin:0 0 20px;">Hi ${safeName}, your agent just charged €${safeAmount} for ${safeService}. Receipt details below.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;margin:8px 0 20px;">
      <tr>
        <td style="padding:8px 0;color:#475569;">Amount</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;color:${BG_NAVY};">€${safeAmount}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#475569;">Service</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;color:${BG_NAVY};">${safeService}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#475569;">Transaction</td>
        <td style="padding:8px 0;text-align:right;">
          <a href="${transactionUrl}" style="color:${ACCENT_TEAL};text-decoration:none;font-weight:600;">View transaction</a>
        </td>
      </tr>
      ${deploymentBlock}
    </table>
    ${primaryButton(transactionUrl, "View transaction")}
    <p style="margin:16px 0 0;color:#475569;">Not you? Pause auto-charges from the dashboard — we will block new authorizations immediately.</p>
  `;

  const html = wrapEmail({
    preheader: `Your agent charged €${amountStr} for ${params.service}.`,
    bodyHtml: body,
  });

  try {
    const { error } = await client.emails.send({
      from: getFromAddress(),
      to: params.to,
      subject: `Your agent charged €${amountStr} for ${params.service}`,
      html,
    });
    if (error) {
      console.error(
        `[email] Resend returned error for charge notification to ${params.to}:`,
        error
      );
      return;
    }
    console.error(
      `[email] Charge notification sent to ${params.to} (€${amountStr} / ${params.service}).`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[email] Failed to send charge notification to ${params.to}: ${message}`
    );
  }
}

/**
 * Build the HMAC-SHA256 token that signs a consent-decision link.
 *
 * The signed string is `${consent_id}:${option}` so an attacker who knows the
 * consent_id cannot pick a different option than the user chose. The HMAC key
 * is MCP_TOKEN_SALT — the same secret used to hash MCP tokens. We only keep
 * the first 32 hex chars (128 bits) to stay within URL length budgets while
 * remaining far beyond brute-forceable for a one-shot decision link.
 */
export function buildConsentDecisionToken(
  consentId: string,
  option: string
): string {
  const salt = process.env.MCP_TOKEN_SALT;
  if (!salt) {
    throw new Error(
      "MCP_TOKEN_SALT is not set. Cannot sign consent decision links."
    );
  }
  return createHmac("sha256", salt)
    .update(`${consentId}:${option}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Constant-time-ish compare for HMAC token verification. We re-derive the
 * expected token and compare lengths first, then character-by-character to
 * avoid trivial early-exit timing leaks. Both inputs are hex strings of equal
 * length so a plain string compare is acceptable, but we keep the explicit
 * loop to make the intent obvious.
 */
export function verifyConsentDecisionToken(
  consentId: string,
  option: string,
  provided: string
): boolean {
  let expected: string;
  try {
    expected = buildConsentDecisionToken(consentId, option);
  } catch {
    return false;
  }
  if (expected.length !== provided.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Weekly digest
// ---------------------------------------------------------------------------

interface DigestServiceLine {
  service: string;
  total_spent_usd: number;
  transaction_count: number;
}

interface DigestTransactionLine {
  id: string;
  created_at: string;
  service: string;
  amount_usd: number;
  description: string | null;
}

interface WeeklyDigestParams {
  to: string;
  displayName?: string;
  weekStart: string; // ISO
  weekEnd: string; // ISO
  totalSpentUsd: number;
  transactionCount: number;
  declinedCount: number;
  successRatePct: number;
  largestCharge: {
    service: string;
    amount_usd: number;
  } | null;
  topServices: DigestServiceLine[];
  recentTransactions: DigestTransactionLine[];
  vsLastWeek: {
    spent_diff_pct: number | null;
    count_diff_pct: number | null;
  };
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatDiffBadge(diff: number | null): string {
  if (diff === null) {
    return `<span style="color:#64748b;font-size:11px;">no data last week</span>`;
  }
  const rounded = Math.round(diff * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  const color =
    rounded > 0 ? "#dc2626" : rounded < 0 ? "#059669" : "#64748b";
  return `<span style="color:${color};font-size:11px;font-weight:600;">${sign}${rounded}% vs last week</span>`;
}

export async function sendWeeklyDigest(
  params: WeeklyDigestParams
): Promise<{ ok: boolean; reason?: string }> {
  const client = getResend();
  if (!client) {
    console.error(
      `[email] Resend not configured — skipping weekly digest to ${params.to}.`
    );
    return { ok: false, reason: "resend-not-configured" };
  }

  const safeName = escapeHtml((params.displayName ?? "").trim() || "there");
  const total = formatAmountEur(params.totalSpentUsd);
  const dashboardBase =
    process.env.SPENDEX_DASHBOARD_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    APP_URL;
  const baseUrl = dashboardBase.replace(/\/+$/, "");
  const unsubscribeUrl = `${baseUrl}/dashboard/settings?unsubscribe=weekly_digest`;

  const weekLabel = `${formatDateShort(params.weekStart)} – ${formatDateShort(
    params.weekEnd
  )}`;
  const safeWeek = escapeHtml(weekLabel);

  const statsRow = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
      <tr>
        <td width="33%" style="padding:12px;background:${BG_NAVY};border-radius:10px;text-align:center;color:#ffffff;">
          <div style="font-size:11px;color:${ACCENT_TEAL};text-transform:uppercase;letter-spacing:0.6px;">Spent</div>
          <div style="font-size:22px;font-weight:700;margin:4px 0;">$${escapeHtml(total)}</div>
          <div>${formatDiffBadge(params.vsLastWeek.spent_diff_pct)}</div>
        </td>
        <td width="6"></td>
        <td width="33%" style="padding:12px;background:#f1f5f9;border-radius:10px;text-align:center;">
          <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.6px;">Transactions</div>
          <div style="font-size:22px;font-weight:700;margin:4px 0;color:${BG_NAVY};">${params.transactionCount}</div>
          <div>${formatDiffBadge(params.vsLastWeek.count_diff_pct)}</div>
        </td>
        <td width="6"></td>
        <td width="33%" style="padding:12px;background:#f1f5f9;border-radius:10px;text-align:center;">
          <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.6px;">Success rate</div>
          <div style="font-size:22px;font-weight:700;margin:4px 0;color:${BG_NAVY};">${escapeHtml(params.successRatePct.toFixed(1))}%</div>
          <div style="color:#64748b;font-size:11px;">${params.declinedCount} declined</div>
        </td>
      </tr>
    </table>`;

  const largestBlock = params.largestCharge
    ? `<p style="margin:0 0 14px;color:#475569;font-size:13px;">
        Largest charge: <strong style="color:${BG_NAVY};">$${escapeHtml(formatAmountEur(params.largestCharge.amount_usd))}</strong>
        on ${escapeHtml(params.largestCharge.service)}.
      </p>`
    : "";

  const topServicesHtml =
    params.topServices.length === 0
      ? `<p style="margin:0;color:#64748b;font-size:13px;">No spend this week.</p>`
      : params.topServices
          .map((s, i) => {
            const safeSvc = escapeHtml(s.service);
            const safeAmt = escapeHtml(formatAmountEur(s.total_spent_usd));
            return `<tr>
              <td style="padding:8px 0;color:${BG_NAVY};font-weight:600;width:24px;">${i + 1}.</td>
              <td style="padding:8px 0;color:${BG_NAVY};text-transform:capitalize;">${safeSvc}</td>
              <td style="padding:8px 0;text-align:right;color:#475569;">${s.transaction_count} tx</td>
              <td style="padding:8px 0;text-align:right;font-weight:600;color:${BG_NAVY};">$${safeAmt}</td>
            </tr>`;
          })
          .join("\n");

  const recentHtml =
    params.recentTransactions.length === 0
      ? `<p style="margin:0;color:#64748b;font-size:13px;">No recent transactions.</p>`
      : params.recentTransactions
          .map((t) => {
            const safeSvc = escapeHtml(t.service);
            const safeAmt = escapeHtml(formatAmountEur(t.amount_usd));
            const safeDate = escapeHtml(formatDateShort(t.created_at));
            const desc =
              t.description && t.description.length > 0
                ? escapeHtml(t.description.slice(0, 60))
                : "";
            return `<tr>
              <td style="padding:8px 0;color:#475569;font-size:12px;width:64px;">${safeDate}</td>
              <td style="padding:8px 0;color:${BG_NAVY};text-transform:capitalize;font-size:13px;">${safeSvc}${desc ? ` <span style="color:#94a3b8;">· ${desc}</span>` : ""}</td>
              <td style="padding:8px 0;text-align:right;font-weight:600;color:${BG_NAVY};font-size:13px;">$${safeAmt}</td>
            </tr>`;
          })
          .join("\n");

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:${BG_NAVY};">Your week, ${safeName}</h1>
    <p style="margin:0 0 16px;color:#475569;font-size:13px;">${safeWeek} — here is what your agents shipped.</p>
    ${statsRow}
    ${largestBlock}
    <h2 style="margin:24px 0 8px;font-size:14px;font-weight:600;color:${BG_NAVY};text-transform:uppercase;letter-spacing:0.5px;">Top services</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;margin:0 0 24px;">
      ${topServicesHtml}
    </table>
    <h2 style="margin:24px 0 8px;font-size:14px;font-weight:600;color:${BG_NAVY};text-transform:uppercase;letter-spacing:0.5px;">Recent transactions</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">
      ${recentHtml}
    </table>
    ${primaryButton(`${baseUrl}/dashboard`, "View full dashboard →")}
    <p style="margin:24px 0 0;color:#94a3b8;font-size:11px;">
      You are receiving this because weekly digests are enabled.
      <a href="${unsubscribeUrl}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a>.
    </p>
  `;

  const html = wrapEmail({
    preheader: `This week: $${total} across ${params.transactionCount} transactions.`,
    bodyHtml: body,
  });

  try {
    const { error } = await client.emails.send({
      from: getFromAddress(),
      to: params.to,
      subject: `Spendex weekly digest — $${total} this week`,
      html,
    });
    if (error) {
      console.error(
        `[email] Resend returned error for weekly digest to ${params.to}:`,
        error
      );
      return { ok: false, reason: error.message ?? "resend-error" };
    }
    console.error(`[email] Weekly digest sent to ${params.to}.`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[email] Failed to send weekly digest to ${params.to}: ${message}`
    );
    return { ok: false, reason: message };
  }
}

// ---------------------------------------------------------------------------
// Consent request notification
// ---------------------------------------------------------------------------

interface ConsentEmailParams {
  to: string;
  consentId: string;
  action: string;
  service: string;
  amountUsd?: number | null;
  context: string;
  options: string[];
  expiresInMinutes?: number;
}

/**
 * Human label for a consent option. The DB stores options as snake_case
 * identifiers; the email user will not understand "auto_create_dedicated_email"
 * unless we humanize it.
 */
function labelForOption(option: string): string {
  const map: Record<string, string> = {
    approve: "Approve",
    decline: "Decline",
    auto_create_dedicated_email: "Auto-create dedicated email",
    auto_create_with_my_email: "Auto-create with my email",
    connect_existing: "Connect existing account",
  };
  if (map[option]) return map[option];
  // Fallback: snake_case → Title Case
  return option
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

/**
 * A "positive" option is anything that is not an explicit decline. The first
 * non-decline option gets the teal primary button styling; remaining positive
 * options get a softer outlined teal style; decline is gray.
 */
function isPositiveOption(option: string): boolean {
  return option !== "decline";
}

function consentButton(
  href: string,
  label: string,
  variant: "primary" | "secondary" | "decline"
): string {
  let background = ACCENT_TEAL;
  let textColor = BG_NAVY;
  let border = ACCENT_TEAL;
  if (variant === "secondary") {
    background = "#ffffff";
    textColor = BG_NAVY;
    border = ACCENT_TEAL;
  } else if (variant === "decline") {
    background = "#e2e8f0";
    textColor = "#475569";
    border = "#cbd5e1";
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0;">
    <tr>
      <td style="border-radius:10px;background:${background};border:1px solid ${border};">
        <a href="${href}" style="display:inline-block;padding:11px 22px;font-family:${FONT_STACK};font-size:14px;font-weight:600;color:${textColor};text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

export async function sendConsentEmail(params: ConsentEmailParams): Promise<void> {
  const client = getResend();
  if (!client) {
    console.error(
      `[email] Resend not configured — skipping consent email to ${params.to}.`
    );
    return;
  }

  const dashboardUrl =
    process.env.SPENDEX_DASHBOARD_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://app.spendexai.com";
  // Normalize: strip a trailing slash so we don't double up on /
  const baseUrl = dashboardUrl.replace(/\/+$/, "");

  const safeAction = escapeHtml(params.action);
  const safeService = escapeHtml(params.service);
  const safeContext = escapeHtml(params.context);
  const amountStr =
    typeof params.amountUsd === "number" && Number.isFinite(params.amountUsd)
      ? `$${params.amountUsd.toFixed(2)}`
      : "—";
  const safeAmount = escapeHtml(amountStr);
  const expiresMinutes = params.expiresInMinutes ?? 30;
  const safeExpires = escapeHtml(String(expiresMinutes));

  // Build a button per option, signing each one with its own HMAC so the
  // recipient cannot tamper with the choice by editing the URL.
  let primaryAssigned = false;
  const buttonsHtml = params.options
    .map((option) => {
      let token: string;
      try {
        token = buildConsentDecisionToken(params.consentId, option);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[email] Failed to sign consent option "${option}": ${message}`
        );
        return "";
      }
      const url =
        `${baseUrl}/api/consent/${encodeURIComponent(params.consentId)}/decide` +
        `?option=${encodeURIComponent(option)}&token=${token}`;
      const label = labelForOption(option);
      let variant: "primary" | "secondary" | "decline";
      if (!isPositiveOption(option)) {
        variant = "decline";
      } else if (!primaryAssigned) {
        variant = "primary";
        primaryAssigned = true;
      } else {
        variant = "secondary";
      }
      return consentButton(url, label, variant);
    })
    .filter(Boolean)
    .join("\n");

  const body = `
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:${BG_NAVY};">Consent needed</h1>
    <p style="margin:0 0 20px;">Your AI agent wants to <strong>${safeAction}</strong> for <strong>${safeService}</strong>. Review the details and choose an option below.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;margin:8px 0 20px;">
      <tr>
        <td style="padding:8px 0;color:#475569;width:120px;">Action</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;color:${BG_NAVY};">${safeAction}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#475569;">Service</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;color:${BG_NAVY};">${safeService}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#475569;">Amount</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;color:${BG_NAVY};">${safeAmount}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#475569;">Context</td>
        <td style="padding:8px 0;text-align:right;color:${BG_NAVY};">${safeContext}</td>
      </tr>
    </table>
    <p style="margin:0 0 8px;font-weight:600;color:${BG_NAVY};">Choose one:</p>
    ${buttonsHtml}
    <p style="margin:24px 0 0;color:#64748b;font-size:12px;">If you didn't initiate this action, click Decline. This request expires in ${safeExpires} minutes.</p>
  `;

  const html = wrapEmail({
    preheader: `Your agent needs consent: ${params.action} on ${params.service}.`,
    bodyHtml: body,
  });

  try {
    const { error } = await client.emails.send({
      from: getFromAddress(),
      to: params.to,
      subject: `Spendex consent needed: ${params.action} on ${params.service}`,
      html,
    });
    if (error) {
      console.error(
        `[email] Resend returned error for consent email to ${params.to}:`,
        error
      );
      return;
    }
    console.error(
      `[email] Consent email sent to ${params.to} (consent_id=${params.consentId}).`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[email] Failed to send consent email to ${params.to}: ${message}`
    );
  }
}
