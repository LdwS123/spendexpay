# Telegram bot setup — Spendex Pay consent channel

Spendex Pay's consent layer delivers approval requests to users through any
of their configured channels. Telegram is one of them: when an agent asks
for consent, the bot pushes a message with one-tap Approve / Decline
buttons. This doc walks through everything needed to bring the bot online.

```
Agent calls MCP tool
        │
        ▼
MCP server creates `consent_requests` row in Supabase
        │
        ▼
MCP server calls POST /api/notify/consent { consent_id }
        │
        ▼
Dashboard fans out to channels: email + Telegram
        │
        ▼  (Telegram)
Bot sendMessage to user's chat_id with inline_keyboard
        │
        ▼
User taps a button
        │
        ▼
Telegram POSTs callback_query to /api/webhooks/telegram
        │
        ▼
Dashboard updates `consent_requests.status` and acks the user
```

---

## 1. Create the bot via @BotFather

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Pick a display name (e.g. `Spendex Pay`).
4. Pick a unique username ending in `bot` (e.g. `spendexpay_bot`).
5. BotFather replies with an HTTP API token that looks like
   `123456789:ABCDEF...`. **Treat this token as a secret** — anyone with
   it can post as your bot.

Recommended one-time tweaks (still in chat with @BotFather):

- `/setdescription` — `Spendex Pay consent notifications. Approve or
  decline AI agent actions in one tap.`
- `/setabouttext` — same as description, shorter.
- `/setuserpic` — upload the Spendex Pay mark.
- `/setjoingroups` — `Disable` (the bot should only DM users).
- `/setprivacy` — `Enable` (privacy mode on; the bot only sees commands
  starting with `/`).

---

## 2. Generate a webhook secret

Telegram supports a secret token sent in the
`X-Telegram-Bot-Api-Secret-Token` header on every webhook delivery. We
require it — without it, anyone who guesses the URL can forge updates.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep the output: it's `TELEGRAM_WEBHOOK_SECRET`.

---

## 3. Configure env vars

In `dashboard/.env.local` (and `/Users/kokabuildsf/Spendexpay/.env` for
the MCP server, if it ever needs to push directly):

```
TELEGRAM_BOT_TOKEN=123456789:ABCDEF...    # from BotFather, step 1
TELEGRAM_WEBHOOK_SECRET=<32-byte hex>     # from step 2
SPENDEX_DASHBOARD_URL=https://app.spendexai.com
```

Restart the dashboard (`npm run dev` or redeploy) so it picks up the new
values.

---

## 4. Register the webhook with Telegram

Replace `<TOKEN>` and `<SECRET>` below with the real values:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://app.spendexai.com/api/webhooks/telegram" \
  -d "secret_token=<SECRET>" \
  -d "allowed_updates=[\"message\",\"callback_query\"]" \
  -d "drop_pending_updates=true"
```

Expected response:

```json
{ "ok": true, "result": true, "description": "Webhook was set" }
```

Verify with `getWebhookInfo`:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

You should see `pending_update_count: 0` and your URL echoed back. If
`last_error_date` / `last_error_message` is populated, fix that error
before going further.

> **Local dev**: Telegram requires HTTPS for webhooks. Use `ngrok http
> 3000` or `cloudflared tunnel --url localhost:3000` and register the
> tunnel URL instead. Re-register every time the tunnel URL changes.

---

## 5. Smoke test

1. Open Telegram and find your bot by its `@username`.
2. Send `/start`.
3. The bot should reply with a message containing your numeric chat ID
   in a monospace block, e.g. `123456789`.
4. Copy that chat ID.
5. In the Spendex dashboard, go to **Settings → Notifications**, paste
   the chat ID into the Telegram field, and toggle Telegram on.
6. Trigger a test consent request (from the MCP server or the dashboard
   "Test consent flow" button if it exists). The bot should DM you a
   formatted card with Approve / Decline buttons.
7. Tap a button. The Spendex dashboard should show the consent as
   approved/declined within a second, and the original message in
   Telegram should update to "Approved — your agent will proceed".

---

## 6. Operational notes

- **`stdout` is the MCP server's JSON-RPC channel** (see `CLAUDE.md`).
  Every Telegram-related log line in this codebase therefore goes to
  `console.error` (stderr). Don't change that.
- The bot's outbound calls (`sendConsentTelegram`,
  `answerCallbackQuery`, `editMessageText`) are all best-effort. A
  blocked bot or kicked chat is logged and swallowed; the user's
  consent state is still authoritative in Supabase.
- The webhook handler uses a service-role Supabase client and updates
  `consent_requests` with `WHERE status='pending'` for optimistic
  concurrency — if the user also clicked the email link a few ms
  earlier, only the first wins.
- If you rotate `TELEGRAM_BOT_TOKEN`, you must re-run the `setWebhook`
  call against the new token; the old token's webhook registration is
  orphaned but harmless.
- If you ever leak the bot token publicly, run `/revoke` in @BotFather
  to get a fresh one and update the env var immediately.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Unauthorized` in dashboard logs on every webhook hit | `TELEGRAM_WEBHOOK_SECRET` differs from what was passed to `setWebhook` | Re-run `setWebhook` with the env var's current value |
| `getWebhookInfo` shows `last_error_message: SSL...` | Your dashboard URL isn't reachable via HTTPS | Use a tunnel (ngrok / cloudflared) for dev, or fix your prod cert |
| `Bot was blocked by the user` in logs | User blocked the bot in Telegram | Log only; no user action required from us. They can re-link later |
| `Forbidden: bot can't initiate conversation with a user` | User has never sent `/start` to the bot | Tell the user they must `/start` once before linking |
| Bot replies in plain text instead of formatted Markdown | An unescaped Markdown V2 character broke parsing | Check the `escapeMarkdownV2` call sites in `src/lib/telegram.ts` |
