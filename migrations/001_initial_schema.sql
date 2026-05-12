-- Spendex Pay v0.1 — initial schema

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Helper: updated_at trigger function
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Table: users
--
-- Core user record. References auth.users so Supabase Auth is the source of
-- truth for identity. The flat service-token columns (vercel_token, etc.) are
-- kept for v0.1 backwards compatibility; the service_tokens table is the v2
-- approach for encrypted, per-service tokens.
-- ---------------------------------------------------------------------------

create table if not exists users (
  -- Identity
  id                          uuid primary key references auth.users(id) on delete cascade,
  email                       text unique not null,

  -- Payment configuration
  payment_method              text
                                check (payment_method in (
                                  'stripe_card',
                                  'paypal',
                                  'ach_bank_transfer',
                                  'coinbase_commerce',
                                  'usdc_base',
                                  'apple_pay',
                                  'google_pay'
                                )),
  -- Provider-specific customer / agreement / wallet ID.
  -- Stored as plain text; TypeScript brands the value at the trust boundary.
  payment_provider_customer_id text,

  -- MCP token (hashed with MCP_TOKEN_SALT before storage; never logged)
  mcp_token                   text unique,

  -- Service tokens (flat columns; v2 will move these to service_tokens table)
  vercel_token                text,
  netlify_token               text,
  railway_token               text,
  fly_token                   text,
  replicate_token             text,
  render_token                text,
  modal_token                 text,

  -- Spending policy
  -- 0 = always require explicit user confirmation before any charge.
  -- > 0 = auto-approve charges up to this amount; surface an error above it.
  max_auto_charge_usd         numeric(10, 2) not null default 0,

  -- Timestamps
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Trigger: keep updated_at current on every update
drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at
  before update on users
  for each row
  execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Table: audit_logs
--
-- Append-only ledger of every MCP tool call that touched (or attempted to
-- touch) a payment provider. This is the source of truth for dispute
-- resolution. Rows are never deleted or modified after the initial insert,
-- except for a status update from the Stripe webhook handler.
-- ---------------------------------------------------------------------------

create table if not exists audit_logs (
  id              uuid        primary key default uuid_generate_v4(),
  user_id         uuid        references users(id) on delete set null,
  service         text        not null,  -- e.g. 'vercel', 'modal', 'railway'
  status          text        not null
                                check (status in (
                                  'success',
                                  'payment_failed',
                                  'deploy_failed_after_payment'
                                )),
  amount_usd      numeric(10, 2),
  description     text,
  -- Stripe PaymentIntent ID ("pi_…"), Coinbase charge ID, etc.
  -- NULL for free-tier actions (amountUsd = 0).
  transaction_id  text,
  error_message   text,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Table: rules
--
-- Per-user spending rules enforced before every payment. Stored as flexible
-- JSONB params so new rule types can be added without a schema migration.
--
-- rule_type examples and their params shapes:
--   max_amount_per_tx      → { "usd": 50.00 }
--   max_amount_per_day     → { "usd": 200.00 }
--   max_amount_per_month   → { "usd": 1000.00 }
--   allowed_services       → { "services": ["vercel", "modal"] }
--   blocked_services       → { "services": ["replicate"] }
--   requires_approval_above → { "usd": 25.00 }
-- ---------------------------------------------------------------------------

create table if not exists rules (
  id          uuid        primary key default uuid_generate_v4(),
  user_id     uuid        not null references users(id) on delete cascade,
  rule_type   text        not null
                            check (rule_type in (
                              'max_amount_per_tx',
                              'max_amount_per_day',
                              'max_amount_per_month',
                              'allowed_services',
                              'blocked_services',
                              'requires_approval_above'
                            )),
  params      jsonb       not null,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Table: virtual_cards
--
-- Stripe Issuing cards provisioned for a user. Each card is scoped to a
-- per-transaction spending limit so an agent can never over-spend even if the
-- Spendex server is compromised.
-- ---------------------------------------------------------------------------

create table if not exists virtual_cards (
  id                        uuid  primary key default uuid_generate_v4(),
  user_id                   uuid  not null references users(id) on delete cascade,
  -- Stripe Issuing card ID — format "ic_…"
  stripe_card_id            text  unique not null,
  stripe_cardholder_id      text  not null,
  spending_limit_per_tx_usd numeric(10, 2),
  -- 'active' | 'inactive' | 'canceled' (mirrors Stripe card statuses)
  status                    text  not null default 'active',
  created_at                timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Table: service_tokens
--
-- Encrypted OAuth / API tokens per user per service. This is the v2
-- replacement for the flat token columns on the users table. Both coexist
-- during the transition; new code should write here, old code still reads
-- the flat columns.
--
-- token_encrypted must be encrypted at the application layer (e.g. AES-256-GCM
-- with a key stored in the environment, not in the DB).
-- ---------------------------------------------------------------------------

create table if not exists service_tokens (
  id              uuid        primary key default uuid_generate_v4(),
  user_id         uuid        not null references users(id) on delete cascade,
  service         text        not null,  -- e.g. 'vercel', 'modal', 'netlify'
  token_encrypted text        not null,
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),

  unique (user_id, service)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- users: MCP token lookup (hot path on every tool call)
create index if not exists idx_users_mcp_token
  on users (mcp_token)
  where mcp_token is not null;

-- audit_logs: per-user history browsing (dashboard transactions page)
create index if not exists idx_audit_logs_user_id
  on audit_logs (user_id);

-- audit_logs: webhook status updates look up by transaction_id
create index if not exists idx_audit_logs_transaction_id
  on audit_logs (transaction_id)
  where transaction_id is not null;

-- audit_logs: time-range queries (spending reports, 7d / 30d / 90d)
create index if not exists idx_audit_logs_created_at
  on audit_logs (created_at desc);

-- rules: per-user rule lookups before every payment
create index if not exists idx_rules_user_id
  on rules (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- All tables are locked down so that a row is only visible / writable by the
-- user who owns it. The service role key (used by the MCP server and dashboard
-- API routes) bypasses RLS — it is never exposed to the browser.
-- ---------------------------------------------------------------------------

alter table users        enable row level security;
alter table audit_logs   enable row level security;
alter table rules        enable row level security;
alter table virtual_cards enable row level security;
alter table service_tokens enable row level security;

-- NOTE: Postgres does NOT support `CREATE POLICY IF NOT EXISTS` (any version).
-- The idempotent pattern is `DROP POLICY IF EXISTS … ; CREATE POLICY …`.

-- users: a user may read and update their own row only
drop policy if exists "users: owner select" on users;
create policy "users: owner select"
  on users for select
  using (auth.uid() = id);

drop policy if exists "users: owner update" on users;
create policy "users: owner update"
  on users for update
  using (auth.uid() = id);

-- audit_logs: a user may read their own logs; inserts and updates are
-- performed exclusively via the service role key
drop policy if exists "audit_logs: owner select" on audit_logs;
create policy "audit_logs: owner select"
  on audit_logs for select
  using (auth.uid() = user_id);

-- rules: a user may manage their own rules
drop policy if exists "rules: owner select" on rules;
create policy "rules: owner select"
  on rules for select
  using (auth.uid() = user_id);

drop policy if exists "rules: owner insert" on rules;
create policy "rules: owner insert"
  on rules for insert
  with check (auth.uid() = user_id);

drop policy if exists "rules: owner update" on rules;
create policy "rules: owner update"
  on rules for update
  using (auth.uid() = user_id);

drop policy if exists "rules: owner delete" on rules;
create policy "rules: owner delete"
  on rules for delete
  using (auth.uid() = user_id);

-- virtual_cards: a user may read their own cards
drop policy if exists "virtual_cards: owner select" on virtual_cards;
create policy "virtual_cards: owner select"
  on virtual_cards for select
  using (auth.uid() = user_id);

-- service_tokens: a user may read their own tokens
drop policy if exists "service_tokens: owner select" on service_tokens;
create policy "service_tokens: owner select"
  on service_tokens for select
  using (auth.uid() = user_id);
