# Pre-Launch Security Checklist

Validate every item before flipping the public-launch switch. Each box should be checked AND dated by the person who validated it.

> Run `./scripts/security-check.sh` first — it automates the patterns marked *(automated)*.

---

## Secrets

- [ ] All secrets rotated since they appeared in transcripts / CI logs — follow `docs/SECRETS-ROTATION.md`
- [ ] `.env` files present in `.gitignore` *(automated)* — verify with `git check-ignore .env`
- [ ] `.mcp.json` present in `.gitignore` *(automated)*
- [ ] `.secrets.new.txt` deleted from disk after copying values into real `.env`
- [ ] No hardcoded production secrets in code *(automated)* — run:
  ```bash
  git grep -E 'sk_(live|test)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9]{20,}' \
    -- ':!*.example' ':!docs/'
  ```
  Must return zero matches.
- [ ] `MCP_TOKEN_SALT` is 32 bytes (64 hex chars) of CSPRNG output
- [ ] `MANAGED_ACCOUNT_ENCRYPTION_KEY` is 32 bytes (64 hex chars) — AES-256 key length
- [ ] No `.env` files committed in repo history (`git log --all -- .env` returns nothing)

## Webhooks

- [ ] Stripe webhook signature verified in `dashboard/app/api/webhooks/stripe/route.ts`
- [ ] Stripe Issuing webhook signature verified in `/api/webhooks/stripe-issuing/route.ts` *(automated)*
- [ ] Resend webhook signature (svix-style) verified on `/api/webhooks/resend-inbound`
- [ ] Telegram webhook checks `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`
- [ ] Webhook replay protection: timestamp window enforced (Stripe gives 5min by default)
- [ ] All webhook handlers return 200 only after writing the audit row

## Authentication & authorization

- [ ] All `/api/*` routes (except webhooks) authenticate via Supabase session cookie — no header-based MCP token auth that the browser can replay
- [ ] MCP tools authenticate via `mcp_token` HMAC compare (timing-safe) — `src/lib/auth.ts` uses `crypto.timingSafeEqual`
- [ ] Dashboard routes under `/dashboard/*` redirect to login if no session
- [ ] RLS enabled on EVERY Supabase table — verify with:
  ```sql
  SELECT schemaname, tablename, rowsecurity
  FROM pg_tables
  WHERE schemaname = 'public' AND rowsecurity = false;
  -- must return zero rows
  ```
- [ ] RLS policies scoped to `auth.uid()` for every user-owned table
- [ ] Service-role key NEVER reaches the browser — only used in `*.server.ts` / route handlers

## CORS & origins

- [ ] CORS configured strict on `/api/*` in production — only `https://spendexai.com` and `https://*.spendexai.com` origins
- [ ] Dashboard `next.config.js` does NOT have `Access-Control-Allow-Origin: *`
- [ ] MCP server is stdio-only (no HTTP listener) — verify no `listen(` calls outside `dashboard/`

## Rate limiting

- [ ] Rate limit on MCP tools active *(see `src/lib/rate-limit.ts` — 10/min, 50/hr per token)*
- [ ] Rate limit on `/api/*` mutation routes (signup, password reset) — Vercel/Fly edge limits or per-IP middleware
- [ ] Stripe Issuing authorization webhook responds in <2s under load

## Cryptography

- [ ] MCP token storage uses HMAC-SHA256 with `MCP_TOKEN_SALT`, NOT raw SHA-256 (salt prevents rainbow-table)
- [ ] Token comparison uses `crypto.timingSafeEqual`, never `===`
- [ ] Managed-account passwords encrypted with AES-256-GCM
- [ ] AES-GCM uses a **random 12-byte IV per encryption** (never reused) — check `src/lib/crypto.ts` calls `randomBytes(12)`
- [ ] AES-GCM auth tag stored alongside ciphertext and verified on decrypt
- [ ] Keys (`MCP_TOKEN_SALT`, `MANAGED_ACCOUNT_ENCRYPTION_KEY`) loaded once at boot, never logged

## Payments

- [ ] `EMERGENCY_STOP` env var read on EVERY payment (not cached) — see `src/config.ts` getter
- [ ] Stripe PaymentIntents always use idempotency key in format `{userId}-{service}-{projectName}-{Date.now()}`
- [ ] Stripe Issuing MCC blocklist enforced server-side: gambling (7995), cash advance (6010, 6011), money transfer (4829, 6051), adult (5967), and any country-restricted MCCs
- [ ] Auto-charge above `max_amount` is BLOCKED — server returns error, does not prompt user inline
- [ ] Authorization webhook audits **both** success AND decline (every event has a row in `stripe_authorizations`)
- [ ] Stripe Issuing card spending cap set in Stripe Dashboard too (defense in depth — not only in our rules engine)
- [ ] Refunds and disputes have a runbook

## Audit logging

- [ ] Every MCP tool call writes an audit row (success or failure)
- [ ] Every Stripe authorization writes an audit row
- [ ] Every consent decision writes an audit row
- [ ] Audit log is append-only (no `UPDATE` or `DELETE` policies on the audit table)
- [ ] Audit rows include: actor (user_id), agent (Claude/Cursor/...), tool, params hash, result, timestamp
- [ ] **No PII in audit logs**: no MCP tokens, no full card numbers, no CVCs, no plaintext passwords. Card last4 OK, BIN OK.

## SSRF / external requests

- [ ] `fetch_product_preview` (and any other server-side fetch) blocks private IP ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`
- [ ] No redirects followed to private IPs (resolve final destination)
- [ ] HTTP timeouts capped (5s default)
- [ ] User-supplied URLs validated against allowlist of schemes (`https:` only in prod)

## Dependencies

- [ ] `npm audit --production` returns 0 high/critical *(automated)*
- [ ] `npm outdated` reviewed; nothing >1 major version behind on security-relevant packages (`stripe`, `@supabase/*`, `next`)
- [ ] Lockfile (`package-lock.json`) committed and matches `package.json`
- [ ] Dependabot or Renovate enabled on the repo

## Logging & observability

- [ ] `console.error` only — stdout is reserved for MCP JSON-RPC frames
- [ ] No secrets in logs (grep production logs for `sk_`, `whsec_`, `mcp_` — must be zero)
- [ ] Sentry / equivalent configured with `beforeSend` scrubber for known secret patterns
- [ ] Alert on: 5xx rate, Stripe webhook 4xx rate, MCP tool error rate, `EMERGENCY_STOP=true` toggled

## Operational

- [ ] Runbook for: leaked-secret response, Stripe dispute, Supabase RLS breach, mass token revocation
- [ ] `EMERGENCY_STOP=true` tested in staging — confirms all payment paths halt
- [ ] Backup of Supabase DB taken in last 24h before launch
- [ ] On-call rotation defined for the first 2 weeks post-launch
- [ ] Status page (statuspage.io / instatus / self-hosted) ready

---

## Sign-off

| Section | Validated by | Date |
|---|---|---|
| Secrets |  |  |
| Webhooks |  |  |
| Auth |  |  |
| Crypto |  |  |
| Payments |  |  |
| Audit |  |  |
| SSRF |  |  |
| Dependencies |  |  |
| Ops |  |  |

**Launch approval:** ____________________ Date: __________
