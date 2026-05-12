-- Spendex Pay — Orders page metadata
--
-- The /dashboard/orders view shows a richer "what did my agent buy?" UI than
-- the raw transactions ledger. To support product previews we record a few
-- optional descriptors on each successful charge:
--
--   * product_url       — canonical URL on the merchant (used as a fallback
--                         link target when the merchant has no native MCP)
--   * product_name      — human-readable label ("Sony WH-1000XM5", "Pro plan")
--   * product_image_url — square thumbnail rendered in the orders feed
--   * currency          — ISO 4217 code; defaults to USD for back-compat
--   * merchant_country  — ISO 3166-1 alpha-2; powers VAT/sales-tax hints
--
-- All columns are nullable / defaulted so this migration is safe to apply
-- against an existing populated audit_logs table without backfill, and the
-- dashboard handles their absence gracefully when the migration has not yet
-- run on the target environment.

alter table audit_logs
  add column if not exists product_url       text,
  add column if not exists product_name      text,
  add column if not exists product_image_url text,
  add column if not exists currency          text default 'USD',
  add column if not exists merchant_country  text;
