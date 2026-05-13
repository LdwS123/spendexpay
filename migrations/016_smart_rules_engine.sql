-- Smart rules engine — LLM-driven purchase intent classification.
--
-- Adds an `intent_classifications` cache keyed by SHA-256 of the
-- (service + description + amount_bucket) tuple so repeated classifications of
-- the same intent (e.g. "subscribe to Vercel Pro" at ~$20) avoid re-calling
-- the LLM. Rows expire after 7 days via the `ttl_expires_at` column — the
-- evaluator filters on `ttl_expires_at > now()` so stale rows are skipped
-- automatically without an eviction job.
--
-- Adds `audit_logs.intent_metadata` so every chargeable transaction carries the
-- classification that was used to evaluate it. This is the dataset that powers
-- future category caps and risk reporting on the dashboard.
--
-- Finally, extends the rules.rule_type CHECK constraint with four new
-- smart-rule types that all operate against classification fields rather than
-- raw amounts.

create extension if not exists "uuid-ossp";

-- Intent classifications cache — avoid re-calling the LLM on identical intents.
create table if not exists intent_classifications (
  id uuid primary key default uuid_generate_v4(),
  description_hash text not null,
  service text not null,
  amount_usd numeric(10, 2),
  category text,                    -- 'dev_tools', 'shopping', 'subscription', 'gambling', etc.
  subcategory text,                  -- 'cloud_compute', 'electronics', 'streaming'
  urgency text check (urgency in ('low', 'medium', 'high')),
  risk_score int check (risk_score >= 0 and risk_score <= 100),
  reasoning text,                    -- LLM's brief explanation
  model text not null default 'claude-haiku-4-5',
  created_at timestamptz not null default now(),
  ttl_expires_at timestamptz not null default (now() + interval '7 days')
);

-- Hot path: "fetch the freshest non-expired classification for this hash".
-- Indexed on (hash, ttl_expires_at desc) so the lookup is an index-only scan.
create index if not exists idx_intent_classifications_hash
  on intent_classifications (description_hash, ttl_expires_at desc);

-- Per-transaction classification storage. JSONB so we can evolve the shape
-- without a follow-up migration (e.g. add new risk axes, alternate models).
alter table audit_logs add column if not exists intent_metadata jsonb;

-- Smart rule types layered on top of the static numeric caps in migrations
-- 001 / 008. Backwards compatible: every legacy rule_type is preserved.
alter table rules drop constraint if exists rules_rule_type_check;
alter table rules add constraint rules_rule_type_check check (rule_type in (
  'max_amount_per_tx', 'max_amount_per_day', 'max_amount_per_month',
  'allowed_services', 'blocked_services', 'requires_approval_above',
  'per_service_monthly_cap', 'per_service_per_tx_cap',
  'category_blocklist',                    -- block categories like 'gambling'
  'category_max_per_month',                -- "max $50/mo on entertainment"
  'risk_threshold',                        -- "decline if LLM risk_score > X"
  'urgency_requires_consent'               -- "consent required for high-urgency"
));
