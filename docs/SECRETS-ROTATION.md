# Secrets Rotation Procedure

**Status:** Required BEFORE public launch.
**Owner:** You (the user). This document is a checklist; execute each step in order.

---

## Why rotate

During development, several production secrets appeared in:

- Claude Code / Cursor conversation transcripts (which are stored by Anthropic / vendors)
- CI logs
- Local shell history
- Possibly screen-shared / pasted snippets

Even if the repo itself has never leaked, **any secret that has appeared in a transcript should be considered compromised** the moment that conversation crosses a network boundary. Before launch we rotate every credential that has touched a transcript or a log file, and we keep going forward with strict secret hygiene (never paste real keys into chats again — paste `.env.example` placeholders instead).

The threat model we're addressing:

1. **Transcript leak** — Anthropic / Cursor / etc. compromised, attacker sees the secrets.
2. **Local exfiltration** — malicious dependency or compromised IDE extension reads `~/.zsh_history` or shell process memory.
3. **Repo leak** — although `.env` and `.mcp.json` are gitignored, a slip-up could push them.

Rotating now means: even if any of the above already happened, the leaked credentials are dead.

---

## The new local secrets

Three secrets have already been generated for you and saved to `.secrets.new.txt` at the repo root (this file is gitignored — verify with `git check-ignore .secrets.new.txt`):

- `MCP_TOKEN_SALT`
- `MANAGED_ACCOUNT_ENCRYPTION_KEY`
- `NOTIFY_INTERNAL_TOKEN`

The others (Stripe, Supabase, Resend, Telegram) you must rotate in their respective dashboards — see below.

After you finish, copy each new value into your real `.env` (and `.mcp.json` where applicable), then delete `.secrets.new.txt`.

---

## Rotation order (do them in this sequence)

The order matters: rotate the things that, when rotated, will invalidate sessions FIRST so we don't end up with a half-rotated state.

### 1. `STRIPE_SECRET_KEY`

- **URL:** https://dashboard.stripe.com/apikeys
- **Steps:**
  1. Click "Roll key" next to the existing secret key (`sk_live_...`).
  2. Stripe offers a grace period (1 hour by default) — set it to **immediate** if you are confident no production traffic is in flight, otherwise keep grace.
  3. Copy the new key.
  4. Update `STRIPE_SECRET_KEY` in your local `.env`, in Fly/Vercel/whichever host runs the MCP server, and in the dashboard's env.
- **Impact:** API calls using the old key fail after grace period expires.
- **Restart:** MCP server, dashboard, any worker that uses Stripe.

### 2. `STRIPE_WEBHOOK_SECRET` and `STRIPE_ISSUING_WEBHOOK_SECRET`

- **URL:** https://dashboard.stripe.com/webhooks
- **Steps (per endpoint, you have at least two):**
  1. Click the webhook endpoint (e.g. `https://<your-domain>/api/webhooks/stripe`).
  2. Click "Reveal" next to "Signing secret".
  3. Click "Roll secret" — Stripe immediately generates a new `whsec_...`.
  4. Repeat for the Issuing webhook (`https://<your-domain>/api/webhooks/stripe-issuing`).
- **Impact:** Webhook deliveries signed with the old secret will fail signature verification — the dashboard handler will reject them with 400. Stripe will retry, so as long as you redeploy within ~1 hour you won't lose events permanently.
- **Restart:** Dashboard app (Next.js) — it reads the env at boot.

### 3. `SUPABASE_SERVICE_ROLE_KEY`

- **URL:** https://supabase.com/dashboard/project/_/settings/api
- **Steps:**
  1. Settings → API → Project API keys.
  2. Find `service_role` (the secret one, not the anon key).
  3. Click "Reset service_role key".
  4. **WARNING:** This invalidates every existing service_role JWT in flight. Every backend (MCP server, dashboard server actions, edge functions) that uses it will start returning 401 until redeployed with the new key.
- **Impact:** All server-side Supabase reads/writes break until restart.
- **Restart:** MCP server, dashboard, Supabase Edge Functions (redeploy with `supabase functions deploy`).
- **Note:** Do NOT roll the `anon` key unless you also have evidence it leaked — rolling it forces every client (browser dashboards, mobile if any) to re-fetch the new key.

### 4. `MCP_TOKEN_SALT`

- **Source:** New value already generated in `.secrets.new.txt`.
- **Impact — READ CAREFULLY:** This salt is used to HMAC every MCP token before storing/comparing it. Rotating the salt **invalidates every existing MCP token in the `mcp_tokens` table**. Every user (you, and any beta testers) must re-generate their MCP token from `/dashboard/tokens` after rotation.
- **Procedure:**
  1. Notify all beta users that their MCP token will be reset.
  2. Deploy the new salt to the MCP server and the dashboard (both read `MCP_TOKEN_SALT`).
  3. In the dashboard at `/dashboard/tokens`, each user clicks "Generate new token", copies it into their `.mcp.json`, and restarts Claude Code / Cursor.
- **Restart:** MCP server + dashboard.
- **Alternative (no user impact):** dual-hash with old and new salt for a deprecation window. Not implemented in code yet — for V1, accept the reset.

### 5. `MANAGED_ACCOUNT_ENCRYPTION_KEY`

- **Source:** New value already generated in `.secrets.new.txt`.
- **Impact — READ CAREFULLY:** This is the AES-256-GCM key for encrypted service-account passwords stored in the DB (the password vault for Vercel, OpenAI, etc. accounts Spendex created on the user's behalf). Rotating without a migration **permanently breaks decryption of every existing password**. Spendex will no longer be able to log in to those services on the user's behalf.
- **Proper procedure (V2):**
  1. Dual-write: load both `OLD_MANAGED_ACCOUNT_ENCRYPTION_KEY` and `MANAGED_ACCOUNT_ENCRYPTION_KEY`.
  2. On every read, try new key first, then fall back to old.
  3. On every read, re-encrypt with new key and write back.
  4. Once a sweep query confirms 0 rows still on old key, remove old key from env.
- **V1 acceptance:** We have no real users yet — accept losing existing encrypted passwords. After rotation, users must re-run `signup_to_service` for any service whose password was vaulted, or the host agent must re-prompt for credentials.
- **Restart:** MCP server + dashboard.

### 6. `NOTIFY_INTERNAL_TOKEN`

- **Source:** New value already generated in `.secrets.new.txt`.
- **Impact:** Low. Used only to authenticate internal cron / worker calls into `/api/notify/*`. No user-facing breakage.
- **Restart:** MCP server, dashboard, any cron worker that calls the notify API.

### 7. `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`

- **URL:** https://resend.com/api-keys and https://resend.com/webhooks
- **Steps:**
  1. API keys → revoke the old key, create a new one with the same scopes (sending + domains read).
  2. Webhooks → click the inbound endpoint (`https://<your-domain>/api/webhooks/resend-inbound`) → "Roll signing secret".
- **Impact:** Outgoing emails (verification, magic links) fail until the new API key is deployed. Inbound webhook (verification emails arriving from services) drops events until the new signing secret is deployed.
- **Restart:** MCP server (uses the API key for outbound), dashboard (handles inbound webhook).

### 8. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`

- **URL:** https://t.me/BotFather
- **Steps:**
  1. Open BotFather → `/mybots` → select your bot → "API Token" → "Revoke current token". A new token is issued.
  2. Update `TELEGRAM_BOT_TOKEN` in env.
  3. Generate a new `TELEGRAM_WEBHOOK_SECRET` (any high-entropy random string; `openssl rand -hex 32` works).
  4. Re-register the webhook with the new secret:
     ```
     curl -X POST "https://api.telegram.org/bot<NEW_TOKEN>/setWebhook" \
       -d "url=https://<your-domain>/api/webhooks/telegram" \
       -d "secret_token=<NEW_WEBHOOK_SECRET>"
     ```
  5. Verify with:
     ```
     curl "https://api.telegram.org/bot<NEW_TOKEN>/getWebhookInfo"
     ```
- **Impact:** The bot stops responding until the new token is deployed; the webhook stops accepting messages until both the new token AND the new secret are deployed and `setWebhook` has been called.
- **Restart:** Dashboard (handles Telegram webhook) + MCP server if it issues outbound bot messages.

---

## After rotation — verification

Run, in order:

```bash
# 1. Confirm the new secrets are NOT in the repo
git grep -E 'sk_(live|test)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9]{20,}' -- ':!*.example' ':!docs/'

# 2. Run the security check script
./scripts/security-check.sh

# 3. Smoke test the MCP server
SPENDEX_DEV=false npm run build && SPENDEX_DEV=false node dist/index.js < /dev/null &
# Then in another shell, test tools/list and a no-op tool call

# 4. Trigger a Stripe test webhook from the Stripe Dashboard ("Send test webhook")
#    and verify the dashboard returns 200, not 400 (signature ok)

# 5. Trigger a Resend test webhook and a Telegram test message, same way

# 6. Delete the local secrets file once everything is verified
shred -u .secrets.new.txt 2>/dev/null || rm -P .secrets.new.txt
```

---

## Going forward — secret hygiene

- Never paste real keys into ANY chat (Claude, Cursor, Slack, screenshots).
- For dev, always use `SPENDEX_DEV=true` or Stripe test mode keys (`sk_test_...`) — these are still secrets but they're firewalled from real money.
- Use `.env.example` placeholders in all docs and tutorials.
- Add a pre-commit hook that runs `scripts/security-check.sh` (gitleaks-style pattern check).
- Audit `mcp_tokens` table monthly — revoke unused tokens.
- Set Stripe Issuing card spending cap at the Stripe-side limit too, not only in our rules engine — defense in depth.
