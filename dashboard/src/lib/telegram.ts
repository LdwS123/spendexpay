/**
 * Telegram Bot API integration for consent notifications.
 *
 * Two surfaces matter:
 *   - sendConsentTelegram(): outbound — pushes a consent request to the user's
 *     chat with an inline keyboard so they can approve/decline with one tap.
 *   - The webhook at /api/webhooks/telegram receives the callback when the
 *     user taps a button; that lives in its own route file.
 *
 * Failure model: every public function in this file is best-effort. Telegram
 * outages, blocked bots, and "chat not found" responses must never crash the
 * caller because the consent request itself is already persisted in Supabase
 * and the user may still get the email channel.
 *
 * All diagnostic output goes to console.error (stderr) to stay consistent
 * with the project's "stdout is sacred" rule (see CLAUDE.md).
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

function getBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === "PLACEHOLDER" || token.startsWith("PLACEHOLDER")) {
    return null;
  }
  return token;
}

interface TelegramResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  // result shape varies per method — we only care about ok/description.
  result?: unknown;
}

/**
 * Low-level helper: POST a JSON payload to a Telegram Bot API method.
 * Returns the parsed response. Throws on network errors so callers can
 * decide whether to swallow or surface — most do swallow.
 */
async function callTelegram(
  method: string,
  payload: Record<string, unknown>
): Promise<TelegramResponse> {
  const token = getBotToken();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set or is a placeholder.");
  }
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Telegram always returns JSON, even on 4xx — try to parse before throwing.
  const text = await res.text();
  let parsed: TelegramResponse;
  try {
    parsed = JSON.parse(text) as TelegramResponse;
  } catch {
    throw new Error(
      `Telegram ${method} returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Markdown escaping
// ---------------------------------------------------------------------------

/**
 * Telegram's MarkdownV2 mode requires escaping a specific set of characters
 * anywhere they appear in regular text. Forgetting one returns
 * 400 Bad Request: can't parse entities.
 *
 * https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMarkdownV2(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Option labelling (kept in sync with email.ts labelForOption)
// ---------------------------------------------------------------------------

function labelForOption(option: string): string {
  const map: Record<string, string> = {
    approve: "Approve",
    decline: "Decline",
    auto_create_dedicated_email: "Auto-create dedicated email",
    auto_create_with_my_email: "Auto-create with my email",
    connect_existing: "Connect existing",
  };
  if (map[option]) return map[option];
  return option
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendConsentTelegramParams {
  chatId: string;
  consentId: string;
  action: string;
  service: string;
  amountUsd?: number | null;
  context: string;
  options: string[];
}

/**
 * Push a consent request to a user's Telegram chat.
 *
 * Builds a MarkdownV2 message summarising the agent's intent and attaches an
 * inline keyboard with one button per option. Button callback_data is encoded
 * as `consent:<id>:<option>` — Telegram limits callback_data to 64 bytes, so
 * we truncate the consent_id if it exceeds the budget (UUID v4 is 36 chars,
 * well under the limit, but we keep the guard for safety).
 */
export async function sendConsentTelegram(
  params: SendConsentTelegramParams
): Promise<void> {
  const token = getBotToken();
  if (!token) {
    console.error(
      `[telegram] TELEGRAM_BOT_TOKEN is not set — skipping consent push for chat_id=${params.chatId}.`
    );
    return;
  }

  const amountLine =
    typeof params.amountUsd === "number" && Number.isFinite(params.amountUsd)
      ? `*Amount:* $${escapeMarkdownV2(params.amountUsd.toFixed(2))}`
      : null;

  const lines = [
    "*Spendex consent needed*",
    "",
    `Your AI agent wants to *${escapeMarkdownV2(params.action)}* for *${escapeMarkdownV2(params.service)}*\\.`,
    "",
    amountLine,
    `*Context:* ${escapeMarkdownV2(params.context)}`,
    "",
    "Tap a button below to respond\\.",
  ].filter((line): line is string => line !== null);
  const text = lines.join("\n");

  // Build the inline keyboard. We put each option on its own row to stay
  // readable on narrow phone screens — 4-option signup flows would otherwise
  // wrap awkwardly in Telegram clients.
  const keyboard = params.options.map((option) => {
    const callbackData = `consent:${params.consentId}:${option}`;
    // Defensive: callback_data must be <= 64 bytes (Telegram limit).
    const safeCallbackData =
      Buffer.byteLength(callbackData, "utf8") <= 64
        ? callbackData
        : callbackData.slice(0, 64);
    return [
      {
        text: labelForOption(option),
        callback_data: safeCallbackData,
      },
    ];
  });

  try {
    const result = await callTelegram("sendMessage", {
      chat_id: params.chatId,
      text,
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: keyboard },
    });
    if (!result.ok) {
      console.error(
        `[telegram] sendMessage failed for chat_id=${params.chatId} (consent=${params.consentId}): ${result.description ?? "unknown error"} (code=${result.error_code ?? "?"}).`
      );
      return;
    }
    console.error(
      `[telegram] Consent push delivered to chat_id=${params.chatId} (consent=${params.consentId}).`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[telegram] Network error pushing consent to chat_id=${params.chatId}: ${message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Webhook-side helpers
// ---------------------------------------------------------------------------

export interface AnswerCallbackQueryParams {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}

/**
 * Acknowledge a callback_query so Telegram stops showing the spinner on the
 * button the user tapped. Best-effort — we never throw, because the consent
 * decision has already been recorded by the time we call this.
 */
export async function answerCallbackQuery(
  params: AnswerCallbackQueryParams
): Promise<void> {
  try {
    const result = await callTelegram("answerCallbackQuery", {
      callback_query_id: params.callbackQueryId,
      text: params.text,
      show_alert: params.showAlert ?? false,
    });
    if (!result.ok) {
      console.error(
        `[telegram] answerCallbackQuery failed: ${result.description ?? "unknown"}.`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] answerCallbackQuery network error: ${message}`);
  }
}

export interface EditMessageTextParams {
  chatId: number | string;
  messageId: number;
  text: string;
  parseMode?: "MarkdownV2" | "HTML";
}

/**
 * Edit a previously sent bot message — used after a user taps a consent
 * button so the message reflects "Approved" / "Declined" rather than the
 * original prompt. Best-effort; failures only log.
 */
export async function editMessageText(
  params: EditMessageTextParams
): Promise<void> {
  try {
    const result = await callTelegram("editMessageText", {
      chat_id: params.chatId,
      message_id: params.messageId,
      text: params.text,
      parse_mode: params.parseMode ?? "MarkdownV2",
      // Strip the inline keyboard — the decision is final.
      reply_markup: { inline_keyboard: [] },
    });
    if (!result.ok) {
      console.error(
        `[telegram] editMessageText failed for chat_id=${params.chatId} msg=${params.messageId}: ${result.description ?? "unknown"}.`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] editMessageText network error: ${message}`);
  }
}

export interface SendTelegramMessageParams {
  chatId: number | string;
  text: string;
  parseMode?: "MarkdownV2" | "HTML";
}

/**
 * Plain sendMessage wrapper used by the webhook to reply to /start and /link
 * commands. Returns success/failure but does not throw.
 */
export async function sendTelegramMessage(
  params: SendTelegramMessageParams
): Promise<void> {
  try {
    const result = await callTelegram("sendMessage", {
      chat_id: params.chatId,
      text: params.text,
      parse_mode: params.parseMode ?? "MarkdownV2",
    });
    if (!result.ok) {
      console.error(
        `[telegram] sendMessage failed for chat_id=${params.chatId}: ${result.description ?? "unknown"}.`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] sendMessage network error: ${message}`);
  }
}

export { escapeMarkdownV2, labelForOption as telegramLabelForOption };
