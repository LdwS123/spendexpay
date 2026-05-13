-- Spendex Pay — virtual phone layer
--
-- This migration adds the two tables that back the "Twilio virtual number
-- per user" feature. The goal is to close the only remaining "exit chat to
-- read SMS" gap in the signup flow: when a downstream service (Vercel,
-- Modal, Amazon, …) sends an SMS verification code, that SMS should land
-- in Spendex infrastructure — not on the user's personal phone.
--
--   virtual_phones — one row per provisioned Twilio number. Soft-released
--                    rows stay forever for audit purposes; the
--                    `released_at IS NULL` predicate is what "active" means.
--
--   sms_messages   — one row per inbound SMS forwarded by Twilio's webhook.
--                    `extracted_code` is parsed best-effort at write time
--                    so the get_sms_code MCP tool can serve in O(1) without
--                    redoing regex on read.
--
-- Both tables live under RLS. The MCP server uses the service-role key
-- (full access policy below); the dashboard runs as the user's auth.uid()
-- and can only SELECT its own rows.
--
-- NOTE on filename: the user-facing brief named this `007_virtual_phone.sql`
-- but `007_audit_logs_status_expand.sql` already exists, so we bumped to
-- 008 to keep migrations strictly ordered. See report for context.

create table if not exists virtual_phones (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references users(id) on delete cascade,

  -- E.164 international format, e.g. "+15551234567". Globally unique because
  -- Twilio cannot lease the same number twice across our account.
  e164_number     text        not null unique,

  -- Twilio's IncomingPhoneNumber SID (PN…). One per leased number. Stored so
  -- we can call `Twilio.api.incomingPhoneNumbers(sid).remove()` at release.
  twilio_sid      text        not null,

  provisioned_at  timestamptz not null default now(),

  -- Soft delete. NULL means the number is still leased and routing inbound
  -- SMS for this user. Non-NULL means we released the number back to Twilio.
  released_at     timestamptz,

  -- One active virtual phone per user. The DEFERRABLE INITIALLY DEFERRED
  -- variant lets us insert a replacement row and release the old one inside
  -- the same transaction without a constraint blip.
  constraint one_active_per_user unique (user_id) deferrable initially deferred
);

create table if not exists sms_messages (
  id                uuid        primary key default gen_random_uuid(),
  virtual_phone_id  uuid        not null references virtual_phones(id) on delete cascade,

  -- The sending phone number — typically a shortcode owned by the service
  -- that sent the code (e.g. Vercel, Amazon). Kept as TEXT because not every
  -- sender presents a parseable E.164 (some use alphanumeric sender IDs).
  from_number       text        not null,

  body              text        not null,

  -- Best-effort extraction at insert time. NULL when the regex did not match
  -- (e.g. marketing SMS with no numeric code). See route.ts for the regex.
  extracted_code    text,

  received_at       timestamptz not null default now(),

  -- Set the moment the `get_sms_code` MCP tool returns this row to the
  -- agent. Codes are single-use from Spendex's perspective; downstream
  -- replay safety is the merchant's problem.
  consumed_at       timestamptz
);

-- Tiny partial index: "find the next unread SMS for this virtual phone."
-- Partial because the predicate is the same one the read path uses and
-- consumed rows are append-only after first read.
create index if not exists idx_sms_messages_phone_unread
  on sms_messages (virtual_phone_id, consumed_at)
  where consumed_at is null;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- The MCP server uses the service role key and bypasses RLS, but we still
-- enable RLS so any future direct dashboard access is locked down by default.
-- ---------------------------------------------------------------------------

alter table virtual_phones enable row level security;
alter table sms_messages   enable row level security;

drop policy if exists "users read own virtual phones" on virtual_phones;
create policy "users read own virtual phones"
  on virtual_phones
  for select
  using (auth.uid() = user_id);

drop policy if exists "service role full access virtual_phones" on virtual_phones;
create policy "service role full access virtual_phones"
  on virtual_phones
  for all
  using (auth.role() = 'service_role');

drop policy if exists "service role full access sms_messages" on sms_messages;
create policy "service role full access sms_messages"
  on sms_messages
  for all
  using (auth.role() = 'service_role');
