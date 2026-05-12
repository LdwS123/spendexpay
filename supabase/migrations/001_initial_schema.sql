-- =============================================================================
-- Migration 001: Initial schema for Spendex Pay
--
-- Spendex Pay is an MCP server that charges users for dev tool services
-- (Vercel deploys, etc.) via multiple payment methods. This migration creates
-- the core tables needed for authentication, transaction logging, payment
-- wallet storage, and per-user spending controls.
--
-- All writes from the server use the Supabase service role key, which bypasses
-- RLS automatically. RLS is still enabled on every table so that if a
-- less-privileged key is ever used (e.g. from a future dashboard), rows are
-- protected by default and explicit grants must be made intentionally.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Use gen_random_uuid() (built into Postgres 13+ via pgcrypto extension).
-- Supabase projects have this enabled by default.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- users
--
-- One row per Spendex Pay account. Created when the user registers on the
-- dashboard and connects a payment method.
--
-- mcp_token: a secret the user pastes into their Claude Code / Cursor config
--   once. The MCP server resolves every inbound request to a user row via
--   this token. It must be unique and treated like a password — never log it.
--
-- payment_method: determines which payment provider the PaymentRouter selects.
--   Kept in sync with the PaymentMethod union type in
--   src/lib/payments/types.ts. Adding a new provider requires updating the
--   CHECK constraint here as well.
--
-- payment_provider_customer_id: the provider-specific identifier for the
--   saved payment instrument. The interpretation depends on payment_method:
--     stripe_card        → Stripe customer ID  ("cus_…")
--     ach_bank_transfer  → Stripe PaymentMethod ID ("pm_…")
--     paypal             → PayPal billing agreement ID ("B-…")
--     usdc_base          → Circle Programmable Wallet ID (UUID)
--     coinbase_commerce  → Coinbase Commerce customer reference
--     apple_pay          → Stripe customer ID  ("cus_…")
--     google_pay         → Stripe customer ID  ("cus_…")
--
-- stripe_customer_id: denormalized convenience column. When payment_method is
--   one of the Stripe-backed methods (stripe_card, ach_bank_transfer,
--   apple_pay, google_pay) this mirrors payment_provider_customer_id so that
--   Stripe-specific queries (e.g. refunds) do not need to inspect
--   payment_method first. NULL for non-Stripe methods.
--
-- max_auto_charge_usd: charges at or below this amount are processed without
--   asking the user for confirmation. 0 means every charge requires approval.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                       text        NOT NULL UNIQUE,
  payment_method              text        NOT NULL
    CONSTRAINT users_payment_method_check CHECK (
      payment_method IN (
        'stripe_card',
        'paypal',
        'ach_bank_transfer',
        'coinbase_commerce',
        'usdc_base',
        'apple_pay',
        'google_pay'
      )
    ),
  payment_provider_customer_id text       NOT NULL,
  -- Denormalized Stripe customer ID — populated only for Stripe-backed methods.
  stripe_customer_id          text,
  -- Token the user pastes into their MCP client config. Treated as a secret.
  mcp_token                   text        NOT NULL UNIQUE,
  vercel_token                text,
  -- Auto-approve threshold. 0 = always require explicit user confirmation.
  max_auto_charge_usd         numeric(10, 4) NOT NULL DEFAULT 0
    CONSTRAINT users_max_auto_charge_usd_non_negative CHECK (max_auto_charge_usd >= 0),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Fast token lookup on every inbound MCP request (the hot path).
CREATE UNIQUE INDEX IF NOT EXISTS users_mcp_token_idx ON users (mcp_token);

-- Dashboard / admin user search by email.
CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);

-- Automatically keep updated_at current on every row update.
-- Defined as a plain function + trigger rather than a generated column so it
-- works across all Postgres versions Supabase supports.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_logs
--
-- Append-only transaction log. One row per payment attempt, regardless of
-- outcome. Never updated after creation — it is the source of truth for:
--   - User-facing billing history (dashboard)
--   - Dispute resolution ("you charged me twice" investigations)
--   - Post-mortem analysis of deploy_failed_after_payment incidents
--
-- status values:
--   success                    — payment collected AND service delivered
--   payment_failed             — provider rejected the charge; no money moved
--   deploy_failed_after_payment — charge collected but service delivery failed;
--                                 a refund may be owed — see transaction_id
--
-- transaction_id: provider-agnostic identifier for the successful charge
--   (Stripe PaymentIntent ID, Coinbase charge ID, etc.). NULL when the
--   payment never reached the provider (payment_failed).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  service        text        NOT NULL,  -- e.g. "vercel", "github_actions"
  status         text        NOT NULL
    CONSTRAINT audit_logs_status_check CHECK (
      status IN (
        'success',
        'payment_failed',
        'deploy_failed_after_payment'
      )
    ),
  amount_usd     numeric(10, 4) NOT NULL DEFAULT 0
    CONSTRAINT audit_logs_amount_usd_non_negative CHECK (amount_usd >= 0),
  description    text        NOT NULL,
  transaction_id text,        -- NULL when payment never succeeded
  error_message  text,        -- NULL on success; provider error string otherwise
  created_at     timestamptz NOT NULL DEFAULT now()
  -- No updated_at: this table is append-only by design. If a row ever needs
  -- correction, insert a new compensating row rather than mutating history.
);

-- The two most common query patterns on audit_logs:
--   1. "Show me this user's transaction history" (dashboard list view)
--   2. "Find this specific charge for a refund or dispute" (ops / support)
--   3. Partitioning / retention jobs that scan by time range

CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx
  ON audit_logs (user_id);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx
  ON audit_logs (created_at DESC);

-- Unique transaction ID lookup for refunds and dispute resolution.
-- Partial index: transaction_id is NULL for failed payments, so only
-- index rows where it is set.
CREATE INDEX IF NOT EXISTS audit_logs_transaction_id_idx
  ON audit_logs (transaction_id)
  WHERE transaction_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- wallets
--
-- Stores additional payment instruments beyond the single default stored in
-- users.payment_provider_customer_id. Supports multi-wallet users in v0.2+.
--
-- At most one wallet per user should have is_default = true. This is NOT
-- enforced with a unique partial index here because toggling the default
-- requires a two-step update (unset old, set new) and doing it atomically
-- inside a transaction is safer than relying on a partial unique constraint.
-- Application code (the dashboard) is responsible for maintaining this
-- invariant.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wallets (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider             text        NOT NULL
    CONSTRAINT wallets_provider_check CHECK (
      provider IN (
        'stripe_card',
        'paypal',
        'ach_bank_transfer',
        'coinbase_commerce',
        'usdc_base',
        'apple_pay',
        'google_pay'
      )
    ),
  -- Provider-specific identifier for this instrument (same semantics as
  -- users.payment_provider_customer_id but scoped to this wallet row).
  provider_customer_id text        NOT NULL,
  is_default           boolean     NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallets_user_id_idx ON wallets (user_id);

-- ---------------------------------------------------------------------------
-- spending_rules
--
-- Per-user spending guardrails evaluated by the PaymentRouter before every
-- charge. Intentionally separate from the users table so that:
--   1. Rules can be edited without touching the authentication-critical users
--      row (reduces blast radius of a bug in the rules update path).
--   2. Future work can version or audit rule changes independently.
--
-- allowed_services: empty array = all services allowed (no allowlist filter).
--   Populated when a user wants to restrict Spendex Pay to specific tools,
--   e.g. ["vercel"] to prevent charges from any other future service.
--
-- monthly_budget_usd: soft cap checked at charge time against the rolling
--   30-day sum of amount_usd from audit_logs. NULL = no monthly budget.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS spending_rules (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One-to-one with users. UNIQUE enforces the one-row-per-user invariant.
  user_id              uuid        NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  -- Per-transaction auto-approval threshold (mirrors users.max_auto_charge_usd
  -- but authoritative here; the users column is a cached copy for fast reads).
  max_auto_charge_usd  numeric(10, 4) NOT NULL DEFAULT 0
    CONSTRAINT spending_rules_max_auto_charge_usd_non_negative
      CHECK (max_auto_charge_usd >= 0),
  -- Rolling 30-day spending cap. NULL disables the cap entirely.
  monthly_budget_usd   numeric(10, 4)
    CONSTRAINT spending_rules_monthly_budget_usd_non_negative
      CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd >= 0),
  -- Allowlist of service names this user permits charges for.
  -- '{}' (empty array) means all services are permitted.
  allowed_services     text[]      NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER spending_rules_set_updated_at
  BEFORE UPDATE ON spending_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- All tables have RLS enabled. The MCP server (and v0.1 dashboard) connect
-- with the service role key, which bypasses RLS entirely — so no policies are
-- required for the server to function.
--
-- RLS is enabled defensively so that:
--   1. Any future code path that accidentally uses the anon or authenticated
--      key gets zero rows rather than a full table leak.
--   2. When we build a proper dashboard with per-user JWT auth, we can add
--      policies here without a schema migration.
--
-- See 002_rls_policies.sql for the actual policy definitions.
-- ---------------------------------------------------------------------------

ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE spending_rules ENABLE ROW LEVEL SECURITY;
