-- Spendex Pay — Web Push subscriptions
--
-- Adds a jsonb column on users to store the PushSubscription returned by
-- the browser's Push API. The payload is opaque to our DB queries — the
-- web-push npm package on the server reads it back as JSON and uses it as
-- the destination for sendNotification.
--
-- Why a column instead of a child table? v1 supports one subscription per
-- user (one browser/PWA). The day we need multi-device push, we lift this
-- into a `push_subscriptions` table keyed by (user_id, endpoint). Until
-- then the column keeps the read path on the notify hot loop to a single
-- row lookup.
--
-- We also widen the default for notification_channels so brand-new prefs
-- rows still default to email-only, but the column can now legally hold
-- "push" alongside "email" / "telegram".

alter table users
  add column if not exists push_subscription jsonb;

comment on column users.push_subscription is
  'Web Push subscription (endpoint + p256dh + auth). NULL when the user has '
  'not opted in or has revoked notifications. Written by '
  '/api/push/subscribe. Read by src/lib/push-notify.ts.';

-- The existing default already is '["email"]', but we re-state it here so
-- this migration is self-documenting for future readers. The notification
-- channels list may now contain "email", "telegram", or "push".
alter table user_consent_preferences
  alter column notification_channels set default '["email"]'::jsonb;
