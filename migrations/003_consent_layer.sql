-- Spendex Pay — consent layer
--
-- This migration introduces the two tables that back the "agent asks the
-- user before acting" feature:
--
--   user_consent_preferences — per-user policy controlling when consent is
--                              required at all. Configurable from the
--                              Settings page in the dashboard.
--
--   consent_requests         — one row per consent prompt sent to the user.
--                              The MCP `request_user_consent` tool inserts
--                              a row in 'pending' status, fires a
--                              notification, then polls for a decision.
--                              The dashboard's approval UI updates the row
--                              to 'approved' / 'declined' / 'expired'.
--
-- Both tables live under RLS so a user can only ever see and update their
-- own rows from the dashboard. The MCP server uses the service role key
-- and bypasses RLS — ownership is enforced explicitly in db.ts helpers.

-- ---------------------------------------------------------------------------
-- Table: user_consent_preferences
--
-- Exactly one row per user. The row is auto-created with defaults the first
-- time a tool asks for the preferences (see getOrCreateConsentPreferences
-- in src/lib/db.ts) so the dashboard never has to upsert defensively.
-- ---------------------------------------------------------------------------

create table if not exists user_consent_preferences (
  user_id                   uuid        primary key
                                        references users(id) on delete cascade,

  -- Top-level consent policy. Each mode changes how `request_user_consent`
  -- decides between auto-approving and prompting the user:
  --   always_ask                 → every request creates a consent_requests row
  --   auto_below_threshold       → auto-approve when amount_usd is set and
  --                                strictly below `auto_below_threshold_usd`
  --   auto_for_trusted_services  → auto-approve when `service` is in
  --                                `trusted_services`
  --   never_auto                 → identical to always_ask today, but kept
  --                                as a distinct value so we can layer a
  --                                stronger policy on it later (e.g. require
  --                                a second factor) without a data migration.
  default_mode              text        not null default 'always_ask'
                                        check (default_mode in (
                                          'always_ask',
                                          'auto_below_threshold',
                                          'auto_for_trusted_services',
                                          'never_auto'
                                        )),

  -- Threshold for the 'auto_below_threshold' mode. Null is allowed so the
  -- mode can be selected before the user has chosen a number; the tool
  -- treats a null threshold as "no auto-approval" (falls back to prompting).
  auto_below_threshold_usd  numeric(10, 2),

  -- List of service slugs the user has marked as trusted. Stored as JSONB
  -- (not text[]) because the dashboard sometimes attaches metadata to each
  -- entry in future iterations; an array of strings is the v1 shape.
  trusted_services          jsonb       not null default '[]'::jsonb,

  -- Channels we should ping when a new consent_request is pending. v1
  -- supports "email" and "telegram"; future values can be added without a
  -- schema change.
  notification_channels     jsonb       not null default '["email"]'::jsonb,

  -- Channel-specific addressing. NULL means "use the default for this user"
  -- (e.g. the email column on users.email). Set when the user opts in.
  telegram_chat_id          text,
  email_for_consent         text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

drop trigger if exists user_consent_preferences_set_updated_at on user_consent_preferences;
create trigger user_consent_preferences_set_updated_at
  before update on user_consent_preferences
  for each row
  execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Table: consent_requests
--
-- Every prompt the MCP server sends to the user. The lifecycle is:
--
--   'pending'   row created, notification fired, MCP tool polling
--      → 'approved'  user picked an option from `options`
--      → 'declined'  user picked "decline" (or equivalent)
--      → 'expired'   no decision arrived before `expires_at`
--
-- Once a row is non-pending it is effectively immutable — the MCP tool reads
-- the final state and returns. We do not garbage-collect rows; the audit
-- trail of consent decisions is intentionally permanent.
-- ---------------------------------------------------------------------------

create table if not exists consent_requests (
  id                  uuid        primary key default uuid_generate_v4(),
  user_id             uuid        not null
                                  references users(id) on delete cascade,

  -- Action the agent wants permission for. Free-form text rather than an
  -- enum so we can introduce new actions without a migration; the MCP tool
  -- side enforces known values. Examples: "signup_to_service",
  -- "pay_for_service", "subscribe", "create_account".
  action              text        not null,

  -- Downstream service / merchant the action targets (e.g. "vercel"). Same
  -- shape as audit_logs.service so dashboards can join across both tables.
  service             text        not null,

  -- Optional USD amount tied to the request. Used to evaluate the
  -- 'auto_below_threshold' policy and to render the prompt UI.
  amount_usd          numeric(10, 2),

  -- Free-form payload the dashboard renders alongside the prompt:
  -- project_name, user_intent, deploy_url, …. Anything not represented by a
  -- typed column above.
  context             jsonb,

  -- Options the user can choose from. Defaults to a basic approve/decline
  -- pair but signup-style flows expand this (auto_create_dedicated_email,
  -- auto_create_my_email, connect_existing, decline). Stored as JSONB so the
  -- order is preserved and the dashboard can render them as a list.
  options             jsonb       not null default '["approve", "decline"]'::jsonb,

  status              text        not null default 'pending'
                                  check (status in (
                                    'pending',
                                    'approved',
                                    'declined',
                                    'expired'
                                  )),

  -- The literal option string the user picked. NULL while status='pending'.
  decision            text,

  -- Optional structured data attached to the decision by the dashboard
  -- (e.g. the existing-account credentials the user wants Spendex to
  -- "connect_existing" with). Opaque to the MCP server.
  decision_metadata   jsonb,

  decision_made_at    timestamptz,

  expires_at          timestamptz not null,

  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Dashboard: "list this user's recent consent requests, most recent first".
create index if not exists idx_consent_requests_user_status
  on consent_requests (user_id, status, created_at desc);

-- Background sweep: "find every still-pending request whose deadline
-- already passed". Partial index keeps it tiny.
create index if not exists idx_consent_requests_pending
  on consent_requests (status, expires_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- The MCP server uses the service role key and bypasses RLS; ownership is
-- enforced manually in db.ts (`getConsentRequest`, `pollConsentDecision`).
-- The policies below scope the dashboard's anon/authed session to the
-- requesting user only.
-- ---------------------------------------------------------------------------

alter table user_consent_preferences enable row level security;
alter table consent_requests         enable row level security;

-- NOTE: Postgres does NOT support `CREATE POLICY IF NOT EXISTS`.
-- The idempotent pattern is `DROP POLICY IF EXISTS … ; CREATE POLICY …`.

drop policy if exists "consent_preferences: owner select" on user_consent_preferences;
create policy "consent_preferences: owner select"
  on user_consent_preferences
  for select
  using (auth.uid() = user_id);

drop policy if exists "consent_preferences: owner update" on user_consent_preferences;
create policy "consent_preferences: owner update"
  on user_consent_preferences
  for update
  using (auth.uid() = user_id);

drop policy if exists "consent_preferences: owner insert" on user_consent_preferences;
create policy "consent_preferences: owner insert"
  on user_consent_preferences
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "consent_requests: owner select" on consent_requests;
create policy "consent_requests: owner select"
  on consent_requests
  for select
  using (auth.uid() = user_id);

-- Update policy lets the dashboard write the chosen decision back to the
-- row. Insert is service-role only — only the MCP server creates requests.
drop policy if exists "consent_requests: owner update" on consent_requests;
create policy "consent_requests: owner update"
  on consent_requests
  for update
  using (auth.uid() = user_id);
