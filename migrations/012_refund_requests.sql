-- Spendex Pay — refund / dispute requests
--
-- User-initiated dispute / refund flow. A row is created when a user clicks
-- "Request refund" on a transaction detail page. The handler in the dashboard
-- API may auto-process the refund via Stripe if the transaction is recent
-- (< 24h), otherwise it stays "pending" until a human (or a future automated
-- job) resolves it.
--
-- audit_log_id is the link back to the original charge in audit_logs. We use
-- ON DELETE SET NULL so that audit log purges (which should be rare) don't
-- cascade-destroy refund history. transaction_id is denormalised onto the row
-- so the user-facing list remains useful even after the audit log is gone.

create table if not exists refund_requests (
  id                   uuid          primary key default uuid_generate_v4(),
  user_id              uuid          not null references users(id) on delete cascade,
  audit_log_id         uuid          references audit_logs(id) on delete set null,
  transaction_id       text,
  amount_usd           numeric(10, 2) not null,
  reason               text          not null
                                      check (reason in (
                                        'not_authorized',
                                        'wrong_amount',
                                        'duplicate',
                                        'not_received',
                                        'cancelled',
                                        'other'
                                      )),
  user_explanation     text,
  status               text          not null default 'pending'
                                      check (status in (
                                        'pending',
                                        'approved',
                                        'declined',
                                        'refunded',
                                        'partial_refund'
                                      )),
  refunded_amount_usd  numeric(10, 2),
  stripe_refund_id     text,
  resolution_note      text,
  created_at           timestamptz   not null default now(),
  resolved_at          timestamptz
);

-- Per-user list view: filter by status, newest first.
create index if not exists idx_refund_requests_user
  on refund_requests (user_id, status, created_at desc);

-- Operator dashboard: find all pending refunds in arrival order.
create index if not exists idx_refund_requests_pending
  on refund_requests (status, created_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table refund_requests enable row level security;

-- A user may read their own refund requests. Inserts and updates happen via
-- the service role key in the dashboard API route, which bypasses RLS.
drop policy if exists "refund_requests: owner select" on refund_requests;
create policy "refund_requests: owner select"
  on refund_requests for select
  using (auth.uid() = user_id);
