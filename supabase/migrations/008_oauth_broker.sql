-- Spendex Pay — OAuth broker (pre-auth identity)
--
-- The "agent that lives in your agents" pitch hinges on the user having ONE
-- relationship with Spendex while Spendex holds N relationships with every
-- downstream service. The OAuth broker is what makes that work for any
-- service whose signup screen says "Continue with GitHub" or
-- "Continue with Google" instead of accepting a fresh email + password.
--
-- During the one-time Spendex onboarding the user authorizes Spendex via
-- the real GitHub / Google OAuth dance (the ONE moment the user leaves
-- chat). We persist the resulting long-lived refresh token here, encrypted
-- with the same AES-256-GCM scheme as managed_accounts.password_encrypted
-- (see src/lib/crypto.ts — key from MANAGED_ACCOUNT_ENCRYPTION_KEY).
--
-- After that point, whenever a downstream signup playbook needs OAuth, the
-- broker exchanges the refresh token for a short-lived access token and
-- hands it to the agent, which completes the "Continue with X" button in
-- the host's browser tool. The user stays in the chat the entire time.
--
-- This migration is intentionally non-destructive (CREATE IF NOT EXISTS
-- everywhere) and adds RLS up front. It does NOT yet wire the actual
-- OAuth exchange — see src/lib/oauth-broker/ for the still-stubbed flow.

-- ---------------------------------------------------------------------------
-- Enum: oauth_provider
--
-- Closed enum on purpose. Adding a third provider means writing the matching
-- client + scope handling in src/lib/oauth-broker/, so the schema enforces
-- "only providers the broker actually knows how to drive" at the DB layer.
-- Extend later with `ALTER TYPE oauth_provider ADD VALUE 'gitlab'` etc.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'oauth_provider') then
    create type oauth_provider as enum ('github', 'google');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- Table: oauth_connections
--
-- One row per (user, provider, provider_user_id). The provider_user_id is
-- in the unique key so a single Spendex user can connect more than one
-- account for the same provider (e.g. personal + work GitHub) — useful for
-- agents that need to push to multiple orgs.
--
-- Tokens are stored as opaque AES-256-GCM ciphertext. NEVER decrypt in SQL.
-- access_token_encrypted is nullable because the access token expires while
-- the refresh token is still valid; getAccessToken() refreshes on demand.
-- ---------------------------------------------------------------------------

create table if not exists oauth_connections (
  id                       uuid           primary key default gen_random_uuid(),
  user_id                  uuid           not null references users(id) on delete cascade,
  provider                 oauth_provider not null,
  provider_user_id         text           not null,             -- the GitHub/Google user ID
  provider_username        text,                                -- display only
  access_token_encrypted   text,                                -- short-lived; may be null after expiry
  access_token_expires_at  timestamptz,
  refresh_token_encrypted  text           not null,             -- long-lived, AES-256-GCM via MANAGED_ACCOUNT_ENCRYPTION_KEY
  scopes                   text[]         not null,
  connected_at             timestamptz    not null default now(),
  revoked_at               timestamptz,
  unique (user_id, provider, provider_user_id)
);

-- Hot path: "give me this user's live connection for provider X" — used by
-- getAccessToken() on every downstream OAuth grant. Partial index keeps it
-- small and skips revoked rows entirely.
create index if not exists idx_oauth_active
  on oauth_connections (user_id, provider)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table oauth_connections enable row level security;

-- A user may read their own connections (the dashboard "Connected accounts"
-- screen lists them). All writes go through the broker, which uses the
-- service role and bypasses RLS.
drop policy if exists "users read own connections" on oauth_connections;
create policy "users read own connections"
  on oauth_connections for select
  using (auth.uid() = user_id);

drop policy if exists "service role full access" on oauth_connections;
create policy "service role full access"
  on oauth_connections for all
  using (auth.role() = 'service_role');
