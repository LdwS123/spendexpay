# Launch day — Spendex Pay

A single, copy-paste runbook to take Spendex Pay from a local repo to a live
production system on `spendexai.com`. Designed to be followed top-to-bottom
in roughly **45 minutes** of active work, plus DNS propagation time.

Every command is copy-paste-ready. Every section ends with a verification step
you can run before moving on. If a check fails, fix that section before
proceeding — skipping a checkpoint will blow up later.

> For deep reference (full env var matrix, rotation policies, advanced ops),
> see [`DEPLOY.md`](../DEPLOY.md). This file is the happy-path launch runbook.

---

## Pre-launch checklist

Tick every box **before** you start Step 1. If any item is missing, fix it
first — the rest of the runbook assumes all of this is already done.

- [ ] Free accounts created: **npm** (`npmjs.com`), **Fly.io** (`fly.io`), **Vercel** (`vercel.com`), **Resend** (`resend.com`), **Cloudflare** (DNS, `cloudflare.com`)
- [ ] **Stripe Issuing** activated on your Stripe account (test mode is fine for launch day; switch to live later)
- [ ] **Supabase** project exists and is reachable: `https://uyjvshuzyglrogzopftm.supabase.co`
- [ ] Domain **`spendexai.com`** registered, DNS pointed to Cloudflare (or your registrar's DNS)
- [ ] All secrets generated and stored in a password manager (`MCP_TOKEN_SALT`, `MANAGED_ACCOUNT_ENCRYPTION_KEY`, `NOTIFY_INTERNAL_TOKEN`). Generate with:
  ```bash
  openssl rand -hex 32
  ```
- [ ] Latest code on `main`:
  ```bash
  cd /Users/kokabuildsf/Spendexpay
  git status                           # working tree clean
  git push origin main
  ```
- [ ] Supabase migrations applied (`001` → `004` from `migrations/`). See [`DEPLOY.md` section 4](../DEPLOY.md#4-supabase--apply-migrations).
- [ ] Tests pass locally:
  ```bash
  npm ci && npm test
  ```

**Checkpoint:** Every box ticked. If not, stop here.

---

## Step 1 — Publish to npm (5 min)

Publishes `@spendexai/mcp` so users can install with one command.

```bash
cd /Users/kokabuildsf/Spendexpay
npm login                              # browser opens, 2FA prompt
npm whoami                             # → your npm username
npm run build
npm test                               # 309 tests, must pass
npm publish --access public
```

**Verify:**

```bash
npx -y @spendexai/mcp@latest --help    # prints usage
npm view @spendexai/mcp version        # matches package.json
```

**Cost:** $0 (public npm packages are free).

**Checkpoint:** Both commands above print real output (no 404, no auth error).

---

## Step 2 — Deploy MCP server to Fly.io (10 min)

Deploys the HTTP transport to Paris (`cdg`), the closest Fly region to Stripe's
EU webhook origins.

```bash
# 2.1 — install + auth (one-time)
brew install flyctl                    # macOS; or curl -L https://fly.io/install.sh | sh
fly auth login                         # browser opens

# 2.2 — provision the app (uses existing fly.toml)
cd /Users/kokabuildsf/Spendexpay
fly launch --copy-config --no-deploy   # answers: yes / no / no / no — keep app name "spendex-mcp"

# 2.3 — set every production secret in one call
fly secrets set \
  SUPABASE_URL="https://uyjvshuzyglrogzopftm.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="$(pbpaste)" \
  STRIPE_SECRET_KEY="$(pbpaste)" \
  STRIPE_WEBHOOK_SECRET="$(pbpaste)" \
  STRIPE_ISSUING_WEBHOOK_SECRET="placeholder-set-after-step-5" \
  STRIPE_CARD_CURRENCY="eur" \
  MCP_TOKEN_SALT="$(pbpaste)" \
  MANAGED_ACCOUNT_ENCRYPTION_KEY="$(pbpaste)" \
  NOTIFY_INTERNAL_TOKEN="$(pbpaste)" \
  SPENDEX_DASHBOARD_URL="https://app.spendexai.com" \
  RESEND_API_KEY="$(pbpaste)"

# (Tip: copy each value to clipboard before running, then $(pbpaste) injects it.
#  Or replace $(pbpaste) with the literal value if you prefer.)

# 2.4 — deploy
fly deploy --remote-only
```

**Verify:**

```bash
fly status                             # 1 machine in "started" state
curl https://spendex-mcp.fly.dev/health
# → {"status":"ok","version":"0.1.0"}

./scripts/smoke-test-mcp.sh https://spendex-mcp.fly.dev
# → all checks pass
```

**Cost:** $0. Fly's free allowance covers one `shared-cpu-1x` 256 MB VM 24/7.

**Checkpoint:** `/health` returns 200 and the smoke test passes.

---

## Step 3 — Deploy dashboard to Vercel (10 min)

```bash
cd /Users/kokabuildsf/Spendexpay/dashboard

# 3.1 — install Vercel CLI if needed
npm i -g vercel
vercel login                           # browser opens

# 3.2 — link to a new (or existing) Vercel project
vercel link                            # pick team, accept default project name "spendex-dashboard"

# 3.3 — set production env vars. Each command prompts for the value and asks
#        which environments to apply to — pick "Production" only.
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add SUPABASE_URL production
vercel env add STRIPE_SECRET_KEY production
vercel env add STRIPE_PUBLISHABLE_KEY production
vercel env add STRIPE_WEBHOOK_SECRET production
vercel env add STRIPE_ISSUING_WEBHOOK_SECRET production
vercel env add STRIPE_CARD_CURRENCY production       # value: eur
vercel env add MCP_TOKEN_SALT production              # must match Fly value
vercel env add MANAGED_ACCOUNT_ENCRYPTION_KEY production   # must match Fly value
vercel env add NOTIFY_INTERNAL_TOKEN production       # must match Fly value
vercel env add NEXT_PUBLIC_DASHBOARD_URL production   # value: https://app.spendexai.com
vercel env add RESEND_API_KEY production
vercel env add RESEND_WEBHOOK_SECRET production       # placeholder for now; set real value in step 6

# 3.4 — deploy
vercel --prod
```

Note the URL Vercel prints (e.g. `https://spendex-dashboard-abc123.vercel.app`).
You'll attach the custom domain in Step 7.

**Verify:**

```bash
# Replace with the URL Vercel just printed:
DASH_URL="https://spendex-dashboard-abc123.vercel.app"

curl "$DASH_URL/api/health"            # → {"status":"ok"}
./scripts/smoke-test-prod.sh "$DASH_URL"
```

**Cost:** $0. Vercel Hobby covers 100 GB bandwidth/month.

**Checkpoint:** `/api/health` returns 200, smoke test passes.

---

## Step 4 — DNS setup (5 min + propagation)

Configure four hostnames at your DNS provider (Cloudflare or registrar)
for `spendexai.com`:

| Host | Type | Value | TTL |
|---|---|---|---|
| `app` | CNAME | `cname.vercel-dns.com.` | 300 |
| `mcp` | CNAME | `spendex-mcp.fly.dev.` | 300 |
| `mail` | MX (priority 10) | `feedback-smtp.eu-west-1.amazonses.com.` | 3600 |
| `mail` | TXT (SPF) | `v=spf1 include:amazonses.com ~all` | 3600 |
| `resend._domainkey.mail` | TXT (DKIM) | *(Resend will provide in Step 6)* | 3600 |
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@spendexai.com` | 3600 |

In **Cloudflare** specifically: for `app` and `mcp`, set the proxy status to
**DNS only** (gray cloud), not proxied — Fly and Vercel terminate TLS themselves.

**Verify:**

```bash
dig app.spendexai.com +short           # → cname.vercel-dns.com.
dig mcp.spendexai.com +short           # → spendex-mcp.fly.dev. + an IP
dig mail.spendexai.com MX +short       # → 10 feedback-smtp.eu-west-1.amazonses.com.
```

If any of these are empty, wait 5–10 minutes and try again.

**Cost:** $0 (Cloudflare DNS is free).

**Checkpoint:** All three `dig` commands return non-empty.

---

## Step 5 — Stripe webhooks (production) (5 min)

Two **separate** endpoints, two **separate** signing secrets. Don't reuse.

**Stripe Dashboard → Developers → Webhooks → Add endpoint:**

### 5a — Payments webhook

- **URL:** `https://app.spendexai.com/api/webhooks/stripe`
- **Events:** `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`
- After creation, click **Reveal signing secret** → copy `whsec_...`
- Update both Fly and Vercel:
  ```bash
  fly secrets set STRIPE_WEBHOOK_SECRET="whsec_..." -a spendex-mcp
  cd dashboard && vercel env rm STRIPE_WEBHOOK_SECRET production -y && vercel env add STRIPE_WEBHOOK_SECRET production
  ```

### 5b — Issuing webhook (synchronous — answers in <2s)

- **URL:** `https://app.spendexai.com/api/webhooks/stripe-issuing`
- **Events:** `issuing_authorization.request`, `issuing_authorization.created`, `issuing_authorization.updated`, `issuing_transaction.created`
- Reveal signing secret → copy `whsec_...`
- Update both Fly and Vercel:
  ```bash
  fly secrets set STRIPE_ISSUING_WEBHOOK_SECRET="whsec_..." -a spendex-mcp
  cd dashboard && vercel env rm STRIPE_ISSUING_WEBHOOK_SECRET production -y && vercel env add STRIPE_ISSUING_WEBHOOK_SECRET production
  vercel --prod                        # redeploy with the new secret
  ```

**Verify:** In the Stripe dashboard, click **Send test webhook** on each endpoint
and confirm a **200 OK** response.

**Cost:** Free in test mode. In live mode: $0.10 per authorization decision.

**Checkpoint:** Both test webhooks return 200.

---

## Step 6 — Resend inbound email (10 min)

Powers the verification-email flow (`signup_to_service` → `get_verification_email`).

1. **Resend Dashboard → Domains → Add Domain → `mail.spendexai.com`**
2. Resend shows the DKIM record. Add it to DNS exactly as displayed (the
   placeholder row from Step 4: `resend._domainkey.mail` TXT).
3. Wait for the domain to turn **green** (usually under 5 min).
4. **Resend Dashboard → API Keys → Create API Key** (name: `spendex-prod`).
   Copy the `re_...` value.
   ```bash
   fly secrets set RESEND_API_KEY="re_..." -a spendex-mcp
   cd dashboard && vercel env rm RESEND_API_KEY production -y && vercel env add RESEND_API_KEY production
   ```
5. **Resend Dashboard → Webhooks → Add Endpoint:**
   - **URL:** `https://app.spendexai.com/api/webhooks/resend-inbound`
   - **Events:** `email.received` (catch-all on `mail.spendexai.com`)
   - Reveal signing secret → copy and set:
   ```bash
   cd dashboard && vercel env rm RESEND_WEBHOOK_SECRET production -y && vercel env add RESEND_WEBHOOK_SECRET production
   vercel --prod                        # redeploy
   ```
6. **Resend Dashboard → Inbound → Catch-all rule:** match `*@mail.spendexai.com`,
   forward to the webhook above.

**Verify:** Send a test email to `signup-test@mail.spendexai.com` from any
mailbox. Check Supabase:

```sql
select * from inbound_emails order by received_at desc limit 1;
```

You should see the test email within 30 seconds.

**Cost:** $0. Resend free tier: 3,000 emails/month, 100/day.

**Checkpoint:** Test email lands in `inbound_emails`.

---

## Step 7 — Vercel custom domain (2 min)

```
Vercel Dashboard → Project → Settings → Domains → Add
  Domain: app.spendexai.com
```

Vercel detects the CNAME from Step 4 and auto-issues a Let's Encrypt TLS cert.

While there, also issue the Fly cert for the MCP server:

```bash
fly certs create mcp.spendexai.com -a spendex-mcp
fly certs show mcp.spendexai.com -a spendex-mcp    # wait until "issued"
```

**Verify:**

```bash
curl -I https://app.spendexai.com      # → 200 with valid TLS
curl -I https://mcp.spendexai.com/health   # → 200 with valid TLS
```

**Cost:** $0 (TLS via Let's Encrypt).

**Checkpoint:** Both URLs serve over HTTPS without cert warnings.

---

## Step 8 — Final smoke test (3 min)

```bash
cd /Users/kokabuildsf/Spendexpay
./scripts/smoke-test-prod.sh https://app.spendexai.com
./scripts/smoke-test-mcp.sh https://mcp.spendexai.com
```

End-to-end consent flow (manual, from Claude Code or any MCP host):

> "Pay $1 to Vercel using Spendex."

Expected sequence — all seven steps must happen:

1. Agent calls `pay_for_service`.
2. Wallet calls `request_user_consent` → markdown prompt + widget in chat.
3. You reply `A`.
4. Agent calls `submit_consent_decision`.
5. Stripe Issuing authorization webhook fires (check Stripe dashboard logs).
6. Audit log has two rows (`authorization_request` + `authorization_approved`):
   ```sql
   select event_type, created_at from audit_log
     order by created_at desc limit 5;
   ```
7. Dashboard `/dashboard/transactions` shows the new entry.

**Checkpoint:** All seven steps observed. If any fails, check `fly logs -a spendex-mcp`
and the relevant Vercel function log.

---

## Step 9 — Beta user invite

You're live. Invite the first 5–10 trusted users:

1. From the dashboard, create their accounts (Settings → Users → Invite).
2. Send them the install snippet:
   ```bash
   # Claude Code
   claude mcp add spendex --transport http https://mcp.spendexai.com/mcp \
     --header "Authorization: Bearer <their-mcp-token>"

   # Or stdio (any MCP host):
   npx -y @spendexai/mcp
   ```
3. Watch `/dashboard/transactions` and `fly logs -a spendex-mcp` for the
   first ~24 hours. Alert on:
   - Any 5xx response from the Issuing webhook (auto-declines authorizations).
   - Any audit log row with `event_type = 'authorization_declined'` you don't expect.
   - Memory usage on the Fly VM > 200 MB sustained (bump VM size if so).

---

## Rollback procedure

If anything looks wrong, roll back the affected layer. Each is independent.

### MCP server (Fly.io)

```bash
fly releases -a spendex-mcp            # list recent deploys
fly releases revert v<n> -a spendex-mcp   # roll back to release n
```

### Dashboard (Vercel)

```bash
cd dashboard
vercel rollback                        # interactive — pick previous deployment
```

Or via the Vercel dashboard → Deployments → previous one → **Promote to Production**.

### npm package

Within 72 hours of publishing:

```bash
npm unpublish @spendexai/mcp@<bad-version>
```

After 72 hours, publish a patch version with the fix instead:

```bash
npm deprecate @spendexai/mcp@0.1.0 "Rolled back, use 0.1.1+"
./scripts/publish.sh patch
```

### Stripe webhook

Stripe Dashboard → Webhooks → endpoint → **Disable** (stops auth decisions
flowing in; existing cards continue to work, new authorizations decline by default).

### Supabase

Pause the project: Supabase Dashboard → Settings → General → Pause. Or write
a reverse migration (`005_revert_xxx.sql`) — **always `pg_dump` the affected
tables first** via the Supabase dashboard backups tab.

### Emergency stop (no rollback needed)

For an immediate halt without redeploy:

```bash
fly secrets set EMERGENCY_STOP=true -a spendex-mcp
```

All payment processing stops within 2 seconds. `config.ts` re-reads the env
var on every call — no restart needed. Unset to resume.

---

## Total cost (free tier, day 1)

| Service | Cost |
|---|---|
| npm public package | $0 |
| Fly.io (1× shared-cpu-1x, 256 MB) | $0 (free tier) |
| Vercel Hobby (100 GB/mo bandwidth) | $0 |
| Supabase (free tier) | $0 |
| Cloudflare DNS | $0 |
| Resend (3,000 emails/mo) | $0 |
| Stripe Issuing (test mode) | $0 |
| Stripe Issuing (live mode) | $0.10 per authorization |

**Total: $0/month** until you cross ~100 active users or move Stripe Issuing
to live mode. The first paid line item is typically Stripe Issuing
authorizations once real users transact.

---

## After launch — first week checklist

- [ ] Set up Fly.io alerts (`fly metrics`) — CPU > 80%, memory > 200 MB, response p95 > 1s
- [ ] Set up Vercel Analytics on the dashboard project
- [ ] Configure Stripe Radar rules for the Issuing program
- [ ] Schedule the 90-day secret rotation (calendar reminder — see `DEPLOY.md` §9)
- [ ] Document the on-call runbook for billing anomalies
- [ ] Add a status page (`status.spendexai.com`) — free via BetterStack or Cronitor

You're done. Welcome to production.
