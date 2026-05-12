-- Spendex Pay — initial schema
-- Run this in the Supabase SQL editor for a fresh project.
-- Safe to re-run: uses IF NOT EXISTS / DO $$ blocks throughout.

-- ─── users ───────────────────────────────────────────────────────────────────

create table if not exists public.users (
  id                          uuid primary key default gen_random_uuid(),
  email                       text not null unique,
  created_at                  timestamptz not null default now(),

  -- Payment method the user configured in the dashboard.
  -- Determines which provider the PaymentRouter selects.
  payment_method              text not null default 'stripe_card'
                                check (payment_method in (
                                  'stripe_card', 'paypal', 'ach_bank_transfer',
                                  'coinbase_commerce', 'usdc_base',
                                  'apple_pay', 'google_pay'
                                )),

  -- Provider-specific customer reference (Stripe cus_…, PayPal B-…, Circle UUID, etc.)
  -- Branded in application code (see src/lib/payments/types.ts); stored as plain text here.
  payment_provider_customer_id text not null default '',

  -- Per-service API tokens — each user generates these in the respective dashboards
  -- and pastes them once into their Spendex account during onboarding.
  vercel_token                text not null default '',
  netlify_token               text not null default '',
  railway_token               text not null default '',
  fly_token                   text not null default '',
  replicate_token             text not null default '',
  render_token                text not null default '',
  modal_token                 text not null default '',

  -- MCP authentication token issued by Spendex dashboard.
  -- Single-use secret the user pastes into their Claude Code / Cursor config.
  -- Never expose to the frontend after generation.
  mcp_token                   text unique,

  -- Agent charges below this threshold are auto-approved.
  -- 0 = require explicit user confirmation for every charge.
  max_auto_charge_usd         numeric(10, 2) not null default 0
);

-- Only the service role (backend) should read/write users.
alter table public.users enable row level security;

-- ─── audit_logs ──────────────────────────────────────────────────────────────

create table if not exists public.audit_logs (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  user_id        uuid not null references public.users(id) on delete cascade,

  -- Which Spendex tool triggered this charge: 'vercel', 'netlify', 'railway', 'flyio', …
  service        text not null,

  -- Terminal outcome of this transaction attempt.
  status         text not null
                   check (status in (
                     'success',
                     'payment_failed',
                     'deploy_failed_after_payment',
                     -- Async settlement statuses written by webhook handlers:
                     'confirmed',   -- ACH/crypto confirmed on-chain
                     'failed'       -- ACH returned / crypto rejected after initial accept
                   )),

  amount_usd     numeric(10, 2) not null,
  description    text not null,

  -- Provider-agnostic transaction reference:
  -- Stripe PaymentIntent ID, Coinbase charge ID, Circle transfer ID, etc.
  -- Null when payment_failed before a provider call was made.
  transaction_id text,

  -- Free-form diagnostic data. On success: Stripe event ID + settled amount.
  -- On failure: provider error message or webhook payload excerpt.
  -- Kept as text (not jsonb) so the dashboard can display it without a schema change.
  error_message  text
);

create index if not exists audit_logs_user_id_idx      on public.audit_logs(user_id);
create index if not exists audit_logs_transaction_id_idx on public.audit_logs(transaction_id);
create index if not exists audit_logs_created_at_idx   on public.audit_logs(created_at desc);

-- Service role only — never expose raw audit logs to the browser client.
alter table public.audit_logs enable row level security;

-- ─── mcp_token index ─────────────────────────────────────────────────────────

-- getUserByMcpToken does an eq filter on this column on every authenticated
-- request. Without an index this is a full table scan.
create unique index if not exists users_mcp_token_idx on public.users(mcp_token)
  where mcp_token is not null;
