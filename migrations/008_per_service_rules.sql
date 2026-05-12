-- Per-service spending limits.
--
-- Extends the existing rules table with two new rule_type values so users
-- can cap spending on a per-merchant basis without abandoning the existing
-- global rules (max_amount_per_tx, max_amount_per_month, …).
--
-- params shape examples:
--   { "service": "vercel", "monthly_cap_usd": 20 }
--   { "service": "modal",  "per_tx_cap_usd": 50 }
--   { "service": "netlify","blocked": true }
--
-- The legacy `blocked_services` / `allowed_services` rules continue to work
-- for users who want a single list across every service; the new rule types
-- are layered on top of that, scoped to one service at a time.

alter table rules drop constraint if exists rules_rule_type_check;
alter table rules add constraint rules_rule_type_check check (rule_type in (
  'max_amount_per_tx',
  'max_amount_per_day',
  'max_amount_per_month',
  'allowed_services',
  'blocked_services',
  'requires_approval_above',
  'per_service_monthly_cap',
  'per_service_per_tx_cap'
));

-- Per-service rule lookups are keyed by the merchant slug inside params,
-- so add a partial index that captures only the new rule types. This keeps
-- the index small (most rows are still the legacy global rule types) while
-- letting the hot-path "fetch active per-service rules for this merchant"
-- query run as an index scan rather than a sequential scan.
create index if not exists idx_rules_per_service
  on rules ((params->>'service'))
  where rule_type in ('per_service_monthly_cap', 'per_service_per_tx_cap');
