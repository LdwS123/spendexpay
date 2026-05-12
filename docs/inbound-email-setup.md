# Inbound email setup — `mail.spendexai.com`

Spendex Pay receives verification emails from downstream services (Vercel,
Modal, Railway, …) on per-account aliases like
`signup-abc123@mail.spendexai.com`. The flow is:

```
Vercel signup form
        │
        │ "We sent a verification email to signup-abc123@mail.spendexai.com"
        ▼
Resend inbound MX  ──POST──▶  /api/webhooks/email-inbound
                                       │
                                       ▼
                              Supabase `inbound_emails`
                                       │
                                       ▼
                              MCP tool `get_verification_email`
                                       │
                                       ▼
                                  Agent reads the link/code,
                                  finishes signup
```

The webhook handler lives at:

```
dashboard/src/app/api/webhooks/email-inbound/route.ts
```

The schema lives at `migrations/002_managed_accounts.sql`.

---

## 1. DNS — point `mail.spendexai.com` at Resend

In your DNS provider for `spendexai.com`, add MX and SPF records on the
`mail` subdomain. The values come from your Resend dashboard under
**Domains → mail.spendexai.com → Inbound** — they look like the table
below but always copy the live values from Resend, since the host can
change as they expand regions.

| Host                  | Type | Priority | Value                          | TTL  |
|-----------------------|------|----------|--------------------------------|------|
| `mail.spendexai.com` | MX   | 10       | `feedback-smtp.resend.com`     | 3600 |
| `mail.spendexai.com` | TXT  | —        | `v=spf1 include:resend.com ~all` | 3600 |

Optional but recommended (set on the parent domain so outbound replies
also authenticate):

| Host                            | Type  | Value                       |
|---------------------------------|-------|-----------------------------|
| `resend._domainkey.spendexai.com` | TXT | _(from Resend DKIM record)_ |
| `_dmarc.spendexai.com`         | TXT   | `v=DMARC1; p=none; rua=mailto:dmarc@spendexai.com` |

Verify propagation:

```sh
dig MX mail.spendexai.com +short
# → 10 feedback-smtp.resend.com.

dig TXT mail.spendexai.com +short
# → "v=spf1 include:resend.com ~all"
```

Resend typically picks the records up within minutes once `dig` returns
the right answers.

---

## 2. Resend — create the inbound endpoint

In the Resend dashboard:

1. **Domains → Add domain → `mail.spendexai.com`** and let Resend verify
   the MX/SPF/DKIM records from step 1.
2. **Webhooks → Add endpoint**
   - URL: `https://<your-dashboard-host>/api/webhooks/email-inbound`
     - In production: `https://app.spendexai.com/api/webhooks/email-inbound`
     - In dev (with `ngrok http 3000`): `https://<id>.ngrok-free.app/api/webhooks/email-inbound`
   - Events: enable `email.received` (also called *Inbound* in Resend's UI).
   - Save and copy the signing secret — Resend shows it once. It looks
     like `whsec_…`.
3. Drop the secret into both env files:
   - `dashboard/.env.local` → `RESEND_WEBHOOK_SECRET=whsec_…`
   - `.env` (MCP server) → `RESEND_WEBHOOK_SECRET=whsec_…`

The handler accepts either the Svix-style `svix-signature` header or
Resend's `resend-signature` header — both formats verify against the
same `whsec_…` secret.

---

## 3. Test end-to-end

### a. Provision a managed account row

The webhook drops emails sent to aliases that don't match a row in
`managed_accounts`. Insert a test row so the message has somewhere to
land:

```sql
insert into managed_accounts (user_id, service, email_alias, password_encrypted, status)
values (
  '00000000-0000-0000-0000-000000000001', -- a real user_id from auth.users
  'vercel',
  'test@mail.spendexai.com',
  'fake-ciphertext-for-test',
  'pending'
);
```

### b. Send a real email

From any mailbox you control:

```
To:      test@mail.spendexai.com
Subject: Verify your account
Body:    Click https://example.com/verify?token=abc123 — code: 123456
```

### c. Verify it landed

```sql
select id, from_address, subject, verification_link, verification_code, received_at
from inbound_emails
where email_alias = 'test@mail.spendexai.com'
order by received_at desc
limit 5;
```

You should see:

- `from_address` populated with your sender
- `verification_link = 'https://example.com/verify?token=abc123'`
- `verification_code = '123456'`
- A populated `raw_payload` jsonb for forensic replay

### d. Watch the logs

Server-side, the handler logs one line per event to stderr:

```
[webhook/email-inbound] Stored inbound email: alias="test@mail.spendexai.com" managed_account_id="…" from="…" subject="Verify your account" link=yes code=yes.
```

If you see `WARNING: no managed_account found for alias=…` the alias
isn't in `managed_accounts` — re-check step (a).

---

## 4. Security notes

The handler enforces three independent gates. None of them can be
disabled without an environment variable change:

1. **Signature verification.** Every request must carry a valid
   `resend-signature` / `svix-signature` header signed with
   `RESEND_WEBHOOK_SECRET`. Requests without a signature, or with a
   forged one, get an immediate `401` and never touch the database. The
   only exception is `SPENDEX_DEV=true`, which skips verification —
   never set that in production.

2. **Domain whitelist.** The `to` address must end in
   `@mail.spendexai.com`. Anything else returns `400`. This stops a
   misconfigured Resend forwarder from pumping arbitrary mail into our
   storage.

3. **Alias-must-be-provisioned.** Emails for aliases that don't match a
   row in `managed_accounts` are dropped (logged warning, `200`
   returned so Resend stops retrying). We never store mail for aliases
   we don't own.

Beyond the handler:

- `password_encrypted` is opaque ciphertext; the MCP server decrypts
  with `MANAGED_ACCOUNT_ENCRYPTION_KEY` (AES-256-GCM). The key lives
  in `.env` and is never logged.
- RLS on `managed_accounts` and `inbound_emails` restricts SELECT to
  the owning user; webhook writes go through the service-role key
  which bypasses RLS — keep that key off the browser.
- Raw payloads include any HTML, headers, and attachments metadata
  Resend forwards. Treat the `raw_payload` jsonb as untrusted user
  input when surfacing it in the dashboard (sanitize HTML, escape
  before render).

---

## 5. Operational

- **Rotation.** To rotate the webhook secret, generate a new one in
  Resend, deploy with both old and new in env (the handler currently
  only reads one — extend `verifySignature` to accept either if you
  need overlap), then remove the old.
- **Replay.** Resend retries non-`2xx` responses with exponential
  backoff for up to ~24 hours. The handler returns `5xx` only for
  transient DB errors; signature failures and domain mismatches return
  `4xx` so Resend stops retrying. Permanent drops (alias not
  provisioned) return `200` to avoid unbounded retries.
- **Inspection.** `select raw_payload from inbound_emails where id = '…'`
  gives you the exact bytes Resend POSTed for any historical message.
