# Deployment runbook

End-to-end runbook for shipping Spendex Pay to production. Read this from
top to bottom the first time; on subsequent deploys you usually only need
section [3](#3-flyio--deploy-the-http-transport) and [10](#10-post-deploy-smoke-tests).

**Prerequisites (one-time):**

- An npm account that owns the `@spendexai` scope (`npm whoami` shows you).
- A Fly.io account with the `fly` CLI installed and `fly auth whoami` working.
- Owner access to the Stripe account, the Supabase project, and the Resend domain.
- DNS control over `spendexai.com`.

---

## Table of contents

1. [Environment variables](#1-environment-variables)
2. [npm — publish `@spendexai/mcp`](#2-npm--publish-spendexaimcp)
3. [Fly.io — deploy the HTTP transport](#3-flyio--deploy-the-http-transport)
4. [Supabase — apply migrations](#4-supabase--apply-migrations)
5. [DNS — MX + CNAME](#5-dns--mx--cname)
6. [Stripe — webhook endpoints](#6-stripe--webhook-endpoints)
7. [Resend — inbound email](#7-resend--inbound-email)
8. [Dashboard — Vercel](#8-dashboard--vercel)
9. [Secret rotation](#9-secret-rotation)
10. [Post-deploy smoke tests](#10-post-deploy-smoke-tests)
11. [Rollback](#11-rollback)

---

## 1. Environment variables

The full list with descriptions lives in `.env.example`. Below is the
production set, grouped by where it gets injected.

### Fly.io secrets (HTTP transport)

| Name | Source |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → Service role key |
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys → `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook (payments) signing secret |
| `STRIPE_ISSUING_WEBHOOK_SECRET` | Stripe webhook (issuing) signing secret — **separate** from the one above |
| `STRIPE_CARD_CURRENCY` | `eur` for EU accounts, `usd` for US |
| `MCP_TOKEN_SALT` | `openssl rand -hex 32` — **must match the dashboard's value** |
| `MANAGED_ACCOUNT_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `NOTIFY_INTERNAL_TOKEN` | `openssl rand -hex 32` — shared with the dashboard for internal callbacks |
| `SPENDEX_DASHBOARD_URL` | `https://app.spendexai.com` |
| `VERCEL_TOKEN` | (optional) Vercel API token for the legacy `deploy_to_vercel` tool |
| `RESEND_API_KEY` | Resend dashboard → API Keys |
| `EMERGENCY_STOP` | Leave unset. Set to `true` only to halt all payments. |

### Dashboard (Vercel) — additional vars

| Name | Source |
|---|---|
| All of the above except `EMERGENCY_STOP` (the dashboard also enforces it) |
| `NEXT_PUBLIC_DASHBOARD_URL` | `https://app.spendexai.com` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_...` from Stripe |

> Generate the three `openssl rand -hex 32` secrets **once** and store them in
> a password manager. They are not recoverable — losing `MANAGED_ACCOUNT_ENCRYPTION_KEY`
> means every encrypted password in `managed_accounts` becomes unreadable.

---

## 2. npm — publish `@spendexai/mcp`

```bash
# 1. Authenticate (one-time per machine)
npm login                                          # 2FA prompt

# 2. Build + test before publishing
npm ci
npm run build                                      # tsc + copy widgets
npm test                                           # vitest, 309 tests

# 3. Publish (publishConfig.access=public is already set in package.json)
npm publish --access public

# 4. Verify
npx @spendexai/mcp@latest --help                   # should print usage
npm view @spendexai/mcp version                    # should match package.json
```

### Bumping the version

Edit `package.json` `version`, then:

```bash
git tag v$(node -p "require('./package.json').version")
git push --tags
npm publish --access public
```

The `prepublishOnly` hook re-runs `npm run build && npm test` automatically,
so a broken build never reaches npm.

---

## 3. Fly.io — deploy the HTTP transport

`fly.toml` is checked in. The app name is `spendex-mcp`, the primary region
is `cdg` (Paris — minimizes latency to Stripe's EU webhook origins).

```bash
# 1. Authenticate (one-time per machine)
fly auth login

# 2. First-time only — provision the app without deploying
fly launch --copy-config --no-deploy

# 3. Set every secret listed in section 1 (Fly.io secrets)
fly secrets set \
  SUPABASE_URL='https://uyjvshuzyglrogzopftm.supabase.co' \
  SUPABASE_SERVICE_ROLE_KEY='...' \
  STRIPE_SECRET_KEY='sk_live_...' \
  STRIPE_WEBHOOK_SECRET='whsec_...' \
  STRIPE_ISSUING_WEBHOOK_SECRET='whsec_...' \
  STRIPE_CARD_CURRENCY='eur' \
  MCP_TOKEN_SALT='...' \
  MANAGED_ACCOUNT_ENCRYPTION_KEY='...' \
  NOTIFY_INTERNAL_TOKEN='...' \
  SPENDEX_DASHBOARD_URL='https://app.spendexai.com' \
  RESEND_API_KEY='re_...'

# 4. Deploy
fly deploy

# 5. Verify
fly status                                         # 1+ machines in "started" state
fly logs                                           # should show "MCP server listening on :3001"
curl https://spendex-mcp.fly.dev/health            # → { "status": "ok", "version": "0.1.0" }
```

### Routine redeploys

After the first launch, every subsequent push is just:

```bash
fly deploy
```

The Dockerfile is a two-stage build — `dist/` + production `node_modules`
only, no TypeScript toolchain in the runtime image.

### Scaling

```bash
fly scale count 2 --region cdg                     # add a second machine in Paris
fly scale vm shared-cpu-2x --memory 512            # bump the VM size
```

`fly.toml` keeps `min_machines_running = 1`, so the service never cold-starts.

---

## 4. Supabase — apply migrations

The repo ships four migrations in `migrations/`:

| File | Adds |
|---|---|
| `001_initial_schema.sql` | `users`, `transactions`, `audit_log`, `idempotency_keys`, `webhook_events`. |
| `002_managed_accounts.sql` | `managed_accounts` (encrypted credentials + email alias) and `inbound_emails`. |
| `003_consent_layer.sql` | `user_consent_preferences` and `consent_requests`. |
| `004_add_missing_service_tokens.sql` | Adds `huggingface_token`, `gamma_api_key`, `cloudflare_token`, `cloudflare_account_id`, `supabase_user_token` to `users`. |

### Option A — Supabase dashboard SQL editor (recommended for first deploy)

1. Open the Supabase project → SQL editor.
2. Paste the contents of `migrations/001_initial_schema.sql` and run.
3. Repeat for `002`, `003`, `004` **in order**.
4. Verify with `select tablename from pg_tables where schemaname = 'public';` — you should see `users`, `transactions`, `audit_log`, `idempotency_keys`, `webhook_events`, `managed_accounts`, `inbound_emails`, `user_consent_preferences`, `consent_requests`.

### Option B — Supabase MCP (faster for repeat deploys)

If you're driving the deploy from Claude with the Supabase MCP installed:

```
mcp__claude_ai_Supabase__apply_migration(
  project_id="<your-project-ref>",
  name="001_initial_schema",
  query="<contents of migrations/001_initial_schema.sql>"
)
```

Then `002`, `003`, `004` in the same way.

### Verifying RLS

After the migrations, run `mcp__claude_ai_Supabase__get_advisors(type="security")`
(or check the dashboard's Database → Advisors tab) to confirm Row Level
Security is enabled on every public table.

---

## 5. DNS — MX + CNAME

Two records to add on the apex zone (`spendexai.com`).

### `mail.spendexai.com` — Resend inbound

| Record | Type | Value | Priority |
|---|---|---|---|
| `mail.spendexai.com` | MX | `feedback-smtp.eu-west-1.amazonses.com` | 10 |
| `mail.spendexai.com` | TXT (SPF) | `v=spf1 include:amazonses.com ~all` | — |
| `resend._domainkey.mail.spendexai.com` | TXT (DKIM) | (value from Resend dashboard) | — |

Confirm with `dig MX mail.spendexai.com +short`. The Resend dashboard
turns the domain green once it has verified DKIM + SPF.

### `mcp.spendexai.com` — Fly.io

| Record | Type | Value |
|---|---|---|
| `mcp.spendexai.com` | CNAME | `spendex-mcp.fly.dev` |

Then in Fly:

```bash
fly certs create mcp.spendexai.com
fly certs show mcp.spendexai.com                   # should report "issued"
```

Update the install docs and the dashboard to point to `https://mcp.spendexai.com/mcp`
once the cert is live.

---

## 6. Stripe — webhook endpoints

Two **separate** endpoints, two **separate** signing secrets. Don't reuse.

### Payments webhook

- URL: `https://app.spendexai.com/api/webhooks/stripe`
- Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`
- Signing secret → `STRIPE_WEBHOOK_SECRET`

### Issuing webhook

- URL: `https://app.spendexai.com/api/webhooks/stripe-issuing`
- Events: `issuing_authorization.request`, `issuing_authorization.created`, `issuing_authorization.updated`, `issuing_transaction.created`
- Signing secret → `STRIPE_ISSUING_WEBHOOK_SECRET`

The issuing webhook is **synchronous** — Stripe waits for a `200` with the
approve/decline decision in the body. The endpoint must answer in under 2
seconds or the authorization is declined by default.

---

## 7. Resend — inbound email

Inbound email feeds the verification-code flow: `signup_to_service` creates
an account using an alias like `signup-<hash>@mail.spendexai.com`, the
downstream service emails a verification link to that alias, Resend
forwards it to our webhook, and `get_verification_email` reads it.

### Steps

1. In the Resend dashboard, add the domain `mail.spendexai.com`.
2. Apply the DNS records from section 5.
3. Wait for the domain to turn green (usually under 5 minutes).
4. In **Webhooks → Inbound**, register the URL `https://app.spendexai.com/api/webhooks/resend-inbound`.
5. Set the catch-all rule: match `*@mail.spendexai.com` and forward to the webhook.

The webhook writes a row to `inbound_emails` keyed by the alias address; the
`get_verification_email` MCP tool queries that table.

---

## 8. Dashboard — Vercel

The dashboard is a separate Next.js app under `dashboard/`. It deploys
independently of the MCP server.

```bash
cd dashboard
vercel link                                        # first time only — links to spendexai/dashboard
vercel env pull .env.production.local              # syncs env vars from Vercel
vercel --prod                                      # deploy to production
```

Custom domain: `app.spendexai.com` → Vercel project's production deployment.

---

## 9. Secret rotation

Rotate at least every 90 days. The order matters for `MCP_TOKEN_SALT`.

| Secret | How |
|---|---|
| Stripe keys | Stripe dashboard → Developers → API keys → Roll. Update Fly + Vercel. |
| Supabase service role | Supabase dashboard → Settings → API → Reset. Update Fly + Vercel. |
| `MCP_TOKEN_SALT` | Generate new value, update **both** Fly and the dashboard at the same time, then re-issue every active MCP token. Old tokens will stop working. |
| `MANAGED_ACCOUNT_ENCRYPTION_KEY` | **Do not rotate without a re-encryption migration.** Rotating this orphans every stored credential. |
| `NOTIFY_INTERNAL_TOKEN` | Generate, update Fly + Vercel together. No user-facing impact. |
| Resend, Stripe webhook secrets | Resend / Stripe dashboards have one-click rotate. Update Fly + Vercel. |

---

## 10. Post-deploy smoke tests

Run these in order. Each should take under 30 seconds.

### a. Health check

```bash
curl https://spendex-mcp.fly.dev/health
# → { "status": "ok", "version": "0.1.0" }
```

### b. MCP `tools/list` over HTTP

```bash
curl -X POST https://spendex-mcp.fly.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

You should see all 23 tools in the response, starting with `pay_for_service`.

### c. Virtual card provisioning

In the dashboard, create a fresh test user and click **Provision wallet**.
Confirm:

- A Stripe Issuing card appears in the Stripe dashboard (Issuing → Cards).
- The dashboard's Services page can reveal the card (Stripe ephemeral key flow works).
- The user row in Supabase has `stripe_cardholder_id` and `stripe_card_id` populated.

### d. Consent flow end-to-end

From any MCP host (Claude Code is easiest):

> "Pay $10 to Vercel using Spendex."

Expected sequence:

1. Agent calls `pay_for_service`.
2. Wallet calls `request_user_consent`.
3. A markdown prompt + widget appears in the chat asking for A / B / C / D.
4. Reply `A`.
5. Agent calls `submit_consent_decision`.
6. Wallet authorizes the charge against the Stripe Issuing card.
7. The Stripe Issuing webhook fires, the audit log gets two rows
   (`authorization_request` + `authorization_approved`), and the tool returns
   the card details.

### e. Audit log

```sql
select * from audit_log order by created_at desc limit 10;
```

Every action in the smoke test should be there with timestamps within seconds of each other.

---

## 11. Rollback

### MCP server (Fly.io)

```bash
fly releases                                       # list recent deploys
fly releases revert v<n>                           # roll back to release n
```

The previous Docker image is kept for at least the last 5 releases.

### npm

`npm` packages are immutable after 72 hours. Within that window:

```bash
npm unpublish @spendexai/mcp@<bad-version>
```

After 72 hours, publish a new patch version with the fix instead.

### Dashboard (Vercel)

```bash
cd dashboard
vercel rollback                                    # interactive — pick a previous deployment
```

### Supabase migrations

There is no automatic rollback for migrations. Write a reverse migration
(`005_revert_xxx.sql`) and apply it the same way as section 4. **Always
back up the affected tables first** via `pg_dump` from the Supabase dashboard.
