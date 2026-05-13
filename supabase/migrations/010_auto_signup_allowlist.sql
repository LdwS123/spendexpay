-- Spendex Pay — auto-signup allowlist
--
-- Adds a per-user list of services for which Spendex is allowed to create
-- accounts WITHOUT a fresh consent prompt. This closes the last "stay in
-- chat" friction point: a user who has set `auto_signup_allowed_services =
-- ARRAY['openai','vercel']` can have their agent sign them up to those
-- services autonomously, while every other service still falls back to the
-- existing `request_user_consent` flow.
--
-- Semantics:
--   - The column is a flat string array (NOT JSONB) — entries are matched
--     case-sensitively against the `service` argument passed to
--     `signup_to_service`. Use lowercase slugs (e.g. "openai", not "OpenAI").
--   - Empty default ('{}') means "no service is pre-whitelisted" — identical
--     to today's behavior, so the migration is a no-op for existing rows.
--   - Membership in this list is a one-way bypass of the consent prompt; it
--     does NOT override an explicit `allow_auto_signup = false` rule on the
--     `rules` table (opt-out is the strongest signal).
--
-- Note: No index is created here. The column is read once per signup call
-- via a row-keyed SELECT (`WHERE user_id = $1`), so the primary-key index on
-- `user_consent_preferences.user_id` is sufficient. Add a GIN index later if
-- we ever need to query "which users trust service X?".

alter table user_consent_preferences
  add column if not exists auto_signup_allowed_services text[] not null default '{}';
