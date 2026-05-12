-- Spendex Pay — managed accounts & inbound email storage
--
-- This migration introduces the two tables that back the "agent provisions
-- its own service account" feature:
--
--   managed_accounts — one row per (user, downstream service) pair. The
--                      row owns a unique email alias under
--                      mail.spendexai.com and an encrypted password the
--                      MCP server uses to log into the downstream service.
--
--   inbound_emails   — append-only log of every email received at one of
--                      the aliases above. The webhook handler at
--                      dashboard/src/app/api/webhooks/email-inbound writes
--                      one row per delivery. Agents read this table to
--                      find verification links / codes.
--
-- The `password_encrypted` column is opaque text — the application layer
-- encrypts with AES-256-GCM using MANAGED_ACCOUNT_ENCRYPTION_KEY. The key
-- never lives in the database.

-- ---------------------------------------------------------------------------
-- Rules: allow_auto_signup flag
--
-- Tri-valued column on the existing rules table:
--   true   → user explicitly opted in
--   false  → user explicitly opted out (signup tool declines)
--   null   → never configured (default behavior, today: allow)
-- ---------------------------------------------------------------------------

alter table rules
  add column if not exists allow_auto_signup boolean;

-- ---------------------------------------------------------------------------
-- Table: managed_accounts
-- ---------------------------------------------------------------------------

create table if not exists managed_accounts (
  id                   uuid        primary key default uuid_generate_v4(),
  user_id              uuid        not null references users(id) on delete cascade,

  -- Downstream service identifier — same shape as audit_logs.service.
  -- e.g. 'vercel', 'modal', 'railway', 'fly'.
  service              text        not null,

  -- Per-account email alias under @mail.spendexai.com. Globally unique so
  -- the inbound-email webhook can look up the owner by alias alone.
  -- Lowercased at write time by the application layer.
  email_alias          text        not null unique,

  -- Application-layer AES-256-GCM ciphertext. NEVER decrypted in SQL.
  -- Format produced by src/lib/crypto.ts: <iv-hex>:<tag-hex>:<ciphertext-hex>.
  password_encrypted   text        not null,

  -- Lifecycle: 'pending' (created locally, not yet signed up) →
  -- 'active' (signed up and usable) → 'disabled' (manual deactivation) →
  -- 'revoked' (downstream service kicked us out).
  status               text        not null default 'pending'
                                   check (status in (
                                     'pending',
                                     'active',
                                     'disabled',
                                     'revoked'
                                   )),

  -- Provider account ID once we know it (e.g. Vercel team id, Modal
  -- workspace id). NULL until the signup flow lands.
  external_account_id  text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- A user only ever needs one managed account per service. If they want
  -- a second, we use a different service slug ('vercel-personal' vs
  -- 'vercel-team') — keep the schema simple here.
  unique (user_id, service)
);

drop trigger if exists managed_accounts_set_updated_at on managed_accounts;
create trigger managed_accounts_set_updated_at
  before update on managed_accounts
  for each row
  execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Table: inbound_emails
--
-- Append-only by convention; no UPDATE policy is granted. Old rows can be
-- archived externally — never modify history in place.
-- ---------------------------------------------------------------------------

create table if not exists inbound_emails (
  id                   uuid        primary key default uuid_generate_v4(),

  -- Denormalised copy of the alias so we can still trace orphaned rows
  -- after a managed_account is force-deleted out of band.
  email_alias          text        not null,

  -- FK to the owning managed_account. ON DELETE CASCADE — if the alias
  -- is retired, drop its mail history with it.
  managed_account_id   uuid        not null
                                   references managed_accounts(id)
                                   on delete cascade,

  from_address         text        not null,
  subject              text,
  body_text            text,
  body_html            text,

  -- Best-effort extraction by the webhook handler. NULL means the parser
  -- did not find an obvious candidate; the agent can fall back to body_text.
  verification_link    text,
  verification_code    text,

  -- Time the upstream mail server received the message (per webhook
  -- payload). Defaults to now() so dashboard ordering still works if the
  -- field is missing.
  received_at          timestamptz not null default now(),

  -- The exact webhook payload, retained for replay / forensic purposes.
  raw_payload          jsonb       not null,

  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index if not exists idx_managed_accounts_user_id
  on managed_accounts (user_id);

create index if not exists idx_managed_accounts_email_alias
  on managed_accounts (email_alias);

-- Hot path: "fetch the newest email for this managed_account". Used by
-- the agent poll loop while waiting for a verification email.
create index if not exists idx_inbound_emails_managed_account_id_received_at
  on inbound_emails (managed_account_id, received_at desc);

-- Secondary path: "fetch by alias" — useful for diagnostics in the
-- dashboard when the managed_account row was deleted out of band.
create index if not exists idx_inbound_emails_email_alias_received_at
  on inbound_emails (email_alias, received_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table managed_accounts enable row level security;
alter table inbound_emails   enable row level security;

-- NOTE: Postgres does NOT support `CREATE POLICY IF NOT EXISTS`.
-- The idempotent pattern is `DROP POLICY IF EXISTS … ; CREATE POLICY …`.

-- managed_accounts: a user may read their own rows. Writes are
-- service-role only (the MCP server provisions, the webhook only reads).
drop policy if exists "managed_accounts: owner select" on managed_accounts;
create policy "managed_accounts: owner select"
  on managed_accounts for select
  using (auth.uid() = user_id);

-- inbound_emails: ownership is indirect — a row is "yours" if the
-- managed_account it references belongs to you. Writes are service-role
-- only (webhook handler bypasses RLS via the service key).
drop policy if exists "inbound_emails: owner select" on inbound_emails;
create policy "inbound_emails: owner select"
  on inbound_emails for select
  using (
    exists (
      select 1
      from managed_accounts
      where managed_accounts.id = inbound_emails.managed_account_id
        and managed_accounts.user_id = auth.uid()
    )
  );
