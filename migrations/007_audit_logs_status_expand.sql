-- Spendex Pay — audit_logs.status expansion + missing columns
--
-- Two reconciliations between code and schema:
--
-- 1. audit_logs.status check constraint was created in 001 with only three
--    legal values (success / payment_failed / deploy_failed_after_payment).
--    Since then the codebase has grown to write six additional statuses:
--      - 'confirmed'        — Stripe Issuing settlement / PayPal capture confirmed
--      - 'failed'           — generic terminal failure (PayPal CAPTURE.DENIED, ...)
--      - 'reversed'         — refund / void after the fact (PayPal REVERSED, ...)
--      - 'payment_pending'  — async provider pending (Coinbase, USDC on Base)
--      - 'consent_pending'  — pay_for_service waiting for a user consent decision
--      - 'consent_declined' — user (or expiry) declined the consent request
--    Every insert with one of those statuses currently fails the CHECK and the
--    audit-log write is lost — which our own rules treat as fatal. This
--    migration expands the constraint to the full set the code writes today.
--
-- 2. The code also writes `transaction_type` and `agent_id` on audit_logs and
--    expects `display_name` and `phone_number` on users (Stripe Issuing
--    cardholder enrichment). Those four columns were never declared in 001
--    and have been added ad-hoc on live. The IF NOT EXISTS guards make this
--    migration safe to re-run against environments where some of them have
--    already been added out of band.
--
-- All operations are idempotent; safe to apply to a fresh DB after 001-006
-- and to an existing prod DB that already has some of the columns.

-- ---------------------------------------------------------------------------
-- Expand audit_logs.status check to include every value the MCP server writes
-- ---------------------------------------------------------------------------

alter table audit_logs
  drop constraint if exists audit_logs_status_check;

alter table audit_logs
  add constraint audit_logs_status_check
    check (status in (
      'success',
      'payment_failed',
      'deploy_failed_after_payment',
      'confirmed',
      'failed',
      'reversed',
      'payment_pending',
      'consent_declined',
      'consent_pending'
    ));

-- ---------------------------------------------------------------------------
-- Add the four columns the application code already references
-- ---------------------------------------------------------------------------

alter table audit_logs
  add column if not exists transaction_type text,
  add column if not exists agent_id         text;

alter table users
  add column if not exists display_name text,
  add column if not exists phone_number text;
