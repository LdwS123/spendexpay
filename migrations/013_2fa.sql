-- Spendex Pay — Two-factor authentication (TOTP)
--
-- Adds three columns on `users` for TOTP-based 2FA:
--   - totp_secret           : base32-encoded shared secret (kept in plaintext for V1
--                              per industry standard; rotate to encrypted blob in V2)
--   - totp_enabled          : flag flipped to true only after the user proves they
--                              successfully scanned the QR code and entered a code
--   - totp_recovery_codes   : 10 SHA-256 hashed recovery codes. The plaintext codes
--                              are returned to the user EXACTLY once at setup time;
--                              we only ever store the hashes so a DB leak does not
--                              compromise the user's recovery path.
--
-- These columns are nullable so they don't break existing rows. The 2FA gate
-- on critical actions is graceful: when `totp_enabled = false` the gate is a
-- no-op and the action proceeds as before.

alter table users
  add column if not exists totp_secret text,
  add column if not exists totp_enabled boolean not null default false,
  add column if not exists totp_recovery_codes text[];

comment on column users.totp_secret is
  'Base32 TOTP shared secret. NULL when the user has not begun 2FA setup. '
  'Cleared when 2FA is disabled. Plaintext is acceptable for V1 — encrypt in V2.';

comment on column users.totp_enabled is
  'True only after the user has verified their first TOTP code. The 2FA gate '
  'on critical routes is a no-op while this is false.';

comment on column users.totp_recovery_codes is
  'Array of 10 SHA-256 hashed recovery codes. Plaintext codes are returned to '
  'the user exactly once during setup and never persisted in clear.';
