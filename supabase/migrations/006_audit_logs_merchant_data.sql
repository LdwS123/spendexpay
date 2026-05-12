-- Spendex Pay — audit_logs merchant enrichment
--
-- Stripe Issuing authorization webhooks carry rich merchant_data in the
-- `issuing_authorization` event payload (name, city, country, MCC category,
-- network_id). Persisting it on the audit log row turns the transactions
-- page into a real ledger:
--   - users see *who* charged them, not just the synthetic service slug;
--   - dispute resolution has the raw network identifier (network_id) that
--     Stripe and the card networks key on;
--   - country fields enable geo-anomaly detection later.
--
-- All columns are nullable so historical rows (inserted before this
-- migration) remain valid without backfill.

alter table audit_logs
  add column if not exists merchant_name        text,
  add column if not exists merchant_city        text,
  add column if not exists merchant_country     text,
  add column if not exists merchant_category    text,
  add column if not exists merchant_network_id  text,
  add column if not exists card_country         text;
