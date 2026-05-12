/**
 * POST /api/webhooks/telegram
 *
 * Telegram Bot webhook endpoint. Telegram POSTs every incoming update
 * (messages, inline-button clicks, etc.) to this URL. We respond to:
 *
 *   - /start                  → instructions + the user's chat_id so they
 *                                can paste it into Settings to link.
 *   - /link <code>            → V1 link flow: user copies a one-time code
 *                                from the dashboard and types /link <code>.
 *                                (TODO: actually persist the code lookup —
 *                                for V1 we accept any code and log it; the
 *                                user_consent_preferences row is updated
 *                                via the dashboard once they paste the
 *                                chat_id back.)
 *   - callback_query          → user tapped an inline button. We decode
 *                                `consent:<id>:<option>`, update the
 *                                consent_requests row, ack the callback,
 *                                and edit the message to reflect the
 *                                decision.
 *
 * Security:
 *   Telegram supports a secret token sent in the
 *   `X-Telegram-Bot-Api-Secret-Token` header (configured via setWebhook).
 *   We require it — without it, anyone can POST forged updates here. If the
 *   header is missing or wrong we return 401.
 *
 * Latency:
 *   Telegram retries a webhook a few times on non-2xx. We always 200 once
 *   we've done our DB work, even if downstream Telegram API calls
 *   (answerCallbackQuery, editMessageText) fail — those failures are logged
 *   but the decision is already recorded.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  answerCallbackQuery,
  editMessageText,
  escapeMarkdownV2,
  sendTelegramMessage,
  telegramLabelForOption,
} from "@/lib/telegram";

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
      "[webhook/telegram] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set."
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Telegram update shapes (only the fields we use)
// ---------------------------------------------------------------------------

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface ConsentRequestRow {
  id: string;
  user_id: string;
  status: string | null;
  options: string[] | null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Verify the secret token. Telegram sends it as a header on every update.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret || expectedSecret === "PLACEHOLDER") {
    console.error(
      "[webhook/telegram] TELEGRAM_WEBHOOK_SECRET not configured — refusing all updates."
    );
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }
  // Constant-time comparison: a naive `!==` leaks the matching-prefix length
  // through timing. `timingSafeEqual` requires equal-length buffers (it
  // throws otherwise — and that throw is itself a timing oracle), so we
  // length-check first and short-circuit before calling into the crypto
  // routine.
  const providedSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const expectedBuf = Buffer.from(expectedSecret, "utf8");
  const providedBuf = Buffer.from(providedSecret, "utf8");
  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    console.error(
      "[webhook/telegram] Rejected update: secret token mismatch."
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    } else {
      // Telegram sends many update types we don't care about (edited
      // messages, channel posts, etc.). Just ack and move on.
      console.error(
        `[webhook/telegram] Ignoring update type id=${update.update_id} (no message/callback).`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[webhook/telegram] Handler threw for update ${update.update_id}: ${message}`
    );
    // Still return 200 so Telegram does not retry — the request itself was
    // authentic; retries won't fix a code bug.
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Message handler (/start, /link <code>)
// ---------------------------------------------------------------------------

async function handleMessage(message: TelegramMessage): Promise<void> {
  const text = (message.text ?? "").trim();
  if (!text) return;

  if (text === "/start" || text.startsWith("/start ")) {
    const chatIdStr = String(message.chat.id);
    const reply = [
      "*Welcome to Spendex Pay\\!*",
      "",
      "To receive consent requests here, copy this chat ID into Settings → Notifications on your dashboard:",
      "",
      `\`${escapeMarkdownV2(chatIdStr)}\``,
      "",
      "Once linked, your agent's consent requests will arrive in this chat with one\\-tap Approve / Decline buttons\\.",
    ].join("\n");
    await sendTelegramMessage({
      chatId: message.chat.id,
      text: reply,
    });
    return;
  }

  if (text.startsWith("/link ")) {
    // V1 simplification: the dashboard is the source of truth for linking.
    // We acknowledge but defer the actual binding to the dashboard UI.
    const code = text.slice("/link ".length).trim();
    console.error(
      `[webhook/telegram] /link received chat_id=${message.chat.id} code=${code} — V1 expects user to paste chat_id into dashboard instead.`
    );
    const reply = [
      "Got it\\. For V1, please open your Spendex dashboard, go to Settings → Notifications, and paste this chat ID:",
      "",
      `\`${escapeMarkdownV2(String(message.chat.id))}\``,
    ].join("\n");
    await sendTelegramMessage({
      chatId: message.chat.id,
      text: reply,
    });
    return;
  }

  // Anything else: short help reply.
  await sendTelegramMessage({
    chatId: message.chat.id,
    text: "Send /start to get your chat ID for linking with Spendex Pay\\.",
  });
}

// ---------------------------------------------------------------------------
// Callback handler (button tap)
// ---------------------------------------------------------------------------

async function handleCallbackQuery(cq: TelegramCallbackQuery): Promise<void> {
  const data = cq.data ?? "";
  // Format: consent:<id>:<option>
  if (!data.startsWith("consent:")) {
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: "Unknown action.",
    });
    return;
  }

  const rest = data.slice("consent:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) {
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: "Malformed action.",
    });
    return;
  }
  const consentId = rest.slice(0, lastColon);
  const option = rest.slice(lastColon + 1);

  if (!consentId || !option) {
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: "Malformed action.",
    });
    return;
  }

  let admin: SupabaseClient;
  try {
    admin = getSupabaseAdmin();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[webhook/telegram] DB unavailable: ${m}`);
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: "Service unavailable. Try again later.",
      showAlert: true,
    });
    return;
  }

  // Load + validate the consent row.
  const { data: consent, error: loadErr } = await admin
    .from("consent_requests")
    .select("id, user_id, status, options")
    .eq("id", consentId)
    .maybeSingle<ConsentRequestRow>();

  if (loadErr) {
    console.error(
      `[webhook/telegram] Failed to load consent ${consentId}: ${loadErr.message}`
    );
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: "Could not load consent request.",
      showAlert: true,
    });
    return;
  }
  if (!consent) {
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: "Consent request not found.",
      showAlert: true,
    });
    return;
  }
  if (consent.status && consent.status !== "pending") {
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: `Already ${consent.status}.`,
      showAlert: true,
    });
    if (cq.message) {
      await editMessageText({
        chatId: cq.message.chat.id,
        messageId: cq.message.message_id,
        text: `*Already ${escapeMarkdownV2(consent.status)}\\.* No further action needed\\.`,
      });
    }
    return;
  }

  const allowedOptions = Array.isArray(consent.options) ? consent.options : [];
  if (allowedOptions.length > 0 && !allowedOptions.includes(option)) {
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: "Option not allowed for this request.",
      showAlert: true,
    });
    return;
  }

  // Decision rule: "decline" → declined, everything else → approved.
  // The specific positive choice is captured in `decision`.
  const newStatus = option === "decline" ? "declined" : "approved";

  const { error: updErr } = await admin
    .from("consent_requests")
    .update({
      status: newStatus,
      decision: option,
      decision_made_at: new Date().toISOString(),
    })
    .eq("id", consentId)
    .eq("status", "pending"); // optimistic concurrency

  if (updErr) {
    console.error(
      `[webhook/telegram] Failed to update consent ${consentId}: ${updErr.message}`
    );
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: "Could not record decision. Try again.",
      showAlert: true,
    });
    return;
  }

  console.error(
    `[webhook/telegram] Consent ${consentId} → ${newStatus} (option=${option}) via chat ${cq.message?.chat.id ?? "?"}.`
  );

  const optionLabel = telegramLabelForOption(option);

  await answerCallbackQuery({
    callbackQueryId: cq.id,
    text:
      newStatus === "approved"
        ? `Approved: ${optionLabel}`
        : `Declined`,
  });

  if (cq.message) {
    const confirmLines =
      newStatus === "approved"
        ? [
            `✅ *Approved\\.* Your agent will proceed\\.`,
            ``,
            `Decision: ${escapeMarkdownV2(optionLabel)}`,
          ]
        : [
            `🛑 *Declined\\.* Your agent has been stopped\\.`,
          ];
    await editMessageText({
      chatId: cq.message.chat.id,
      messageId: cq.message.message_id,
      text: confirmLines.join("\n"),
    });
  }
}
