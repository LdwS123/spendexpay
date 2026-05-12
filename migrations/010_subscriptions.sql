-- Spendex Pay — recurring subscriptions
--
-- `pay_for_service` is one-shot: agent charges, user is debited, the tool
-- returns. For services that bill on a recurring cadence (Vercel Pro $20/mo,
-- Netflix, Spotify, GitHub Pro, …) we need to track an active subscription
-- and re-evaluate the user's spending rules at each renewal — surfacing the
-- subscription to the dashboard so users can pause/cancel without having to
-- log in to every merchant individually.
--
-- The table records the SCHEDULE only. A separate cron job (V3) reads rows
-- where status='active' and next_charge_at<=now() and triggers the actual
-- charge through the existing pay_for_service path. Until that cron lands,
-- creating a row just persists the intent so the dashboard can show it and
-- the rules engine can count it against the user's monthly budget projection.

create table if not exists subscriptions (
  id              uuid        primary key default uuid_generate_v4(),
  user_id         uuid        not null references users(id) on delete cascade,
  service         text        not null,
  amount_usd      numeric(10, 2) not null,
  currency        text        not null default 'USD',
  -- 'monthly' is the most common; 'yearly' for annual plans (JetBrains,
  -- Cursor Pro); 'weekly' kept for niche recurring credits use cases.
  interval        text        not null check (interval in ('monthly', 'yearly', 'weekly')),
  -- 'active'   normal — next_charge_at drives the renewal cron
  -- 'paused'   user paused; cron skips this row until status flips back
  -- 'cancelled' terminal; row kept for audit / history
  -- 'past_due' last renewal failed (rules decline or payment error); cron
  --            will retry per V3 backoff policy
  status          text        not null default 'active'
                    check (status in ('active', 'paused', 'cancelled', 'past_due')),
  description     text,
  started_at      timestamptz not null default now(),
  next_charge_at  timestamptz not null,
  last_charged_at timestamptz,
  cancelled_at    timestamptz,
  -- Free-form provider metadata (Stripe subscription ID once we have one,
  -- plan slug, merchant-side account ID, …). Kept JSONB so we can extend
  -- without a migration for every new integration.
  metadata        jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Hot path: dashboard "list my subscriptions" filtered by user and status,
-- ordered by next charge date. The (user_id, status, next_charge_at) shape
-- supports both the dashboard query and the V3 cron's "what's due" scan.
create index if not exists idx_subscriptions_user_status
  on subscriptions (user_id, status, next_charge_at);

-- Partial index for the renewal cron — only active rows are eligible to
-- fire. Keeps the index small (cancelled/past_due/paused rows excluded)
-- while letting `WHERE status='active' AND next_charge_at<=now()` run as
-- an index range scan.
create index if not exists idx_subscriptions_due
  on subscriptions (status, next_charge_at)
  where status = 'active';

-- Keep updated_at fresh on every mutation. Reuses the trigger function
-- created in 001_initial_schema.sql.
drop trigger if exists subscriptions_set_updated_at on subscriptions;
create trigger subscriptions_set_updated_at
  before update on subscriptions
  for each row
  execute function set_updated_at();

-- RLS — same shape as the rest of the schema: a user can read their own
-- subscriptions; writes are restricted to the service role used by the
-- MCP server and the dashboard API.
alter table subscriptions enable row level security;

drop policy if exists "subscriptions: owner select" on subscriptions;
create policy "subscriptions: owner select"
  on subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "subscriptions: owner update" on subscriptions;
create policy "subscriptions: owner update"
  on subscriptions for update
  using (auth.uid() = user_id);
