-- =============================================================================
-- Migration 002: Row Level Security policies for Spendex Pay
--
-- Context
-- -------
-- The Spendex Pay MCP server connects to Supabase using the SERVICE ROLE key,
-- which bypasses RLS by design (Postgres grants superuser-equivalent privileges
-- to the service role). No explicit policy is needed for server operations.
--
-- The v0.1 dashboard also uses the service role key because there is no
-- per-user JWT auth yet. That means dashboard requests are also not subject
-- to RLS.
--
-- Why enable RLS at all then?
-- ---------------------------
-- Enabling RLS without policies creates a "default deny" posture:
--   - Any query made with the ANON key or an AUTHENTICATED JWT returns 0 rows
--     and 0 affected rows — no data is leaked even if a key is accidentally
--     exposed or a future code path forgets to use the service role.
--   - When we add per-user dashboard auth (v0.2), we can drop the explicit
--     "deny all" policy below and add narrow "users can see their own rows"
--     policies in a new migration without touching the table schema.
--
-- Policy naming convention
-- ------------------------
-- "{table}_{role}_{action}" — makes the list of policies self-documenting
-- in the Supabase dashboard and in pg_policies.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- users table
--
-- The service role bypasses these policies automatically (Postgres behavior).
-- Anon and authenticated callers are explicitly denied all operations.
-- We use a single "deny all" policy per role rather than omitting policies
-- because an empty policy list with RLS enabled already denies everything —
-- but explicit policies make the intent clear in pg_policies and the
-- Supabase dashboard, reducing confusion for future engineers.
-- ---------------------------------------------------------------------------

-- No SELECT for anonymous clients. mcp_token values and Vercel tokens stored
-- in this table are equivalent to passwords and must never be readable by
-- untrusted callers.
CREATE POLICY users_anon_deny_all ON users
  AS RESTRICTIVE
  FOR ALL
  TO anon
  USING (false);

-- Authenticated (JWT) users have no access in v0.1. When the per-user
-- dashboard is built, replace this with a policy scoped to auth.uid() = id.
CREATE POLICY users_authenticated_deny_all ON users
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (false);

-- ---------------------------------------------------------------------------
-- audit_logs table
--
-- Audit logs contain transaction IDs and charge amounts. They must not be
-- readable by anon clients or by authenticated users other than the record
-- owner. The owner-scoped policy will be added in v0.2 when JWT auth lands.
-- ---------------------------------------------------------------------------

CREATE POLICY audit_logs_anon_deny_all ON audit_logs
  AS RESTRICTIVE
  FOR ALL
  TO anon
  USING (false);

CREATE POLICY audit_logs_authenticated_deny_all ON audit_logs
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (false);

-- ---------------------------------------------------------------------------
-- wallets table
--
-- Provider customer IDs (Stripe, PayPal agreement IDs, Circle wallet UUIDs)
-- are sensitive payment credentials. Block all non-service-role access until
-- we have a dashboard with properly scoped JWT auth.
-- ---------------------------------------------------------------------------

CREATE POLICY wallets_anon_deny_all ON wallets
  AS RESTRICTIVE
  FOR ALL
  TO anon
  USING (false);

CREATE POLICY wallets_authenticated_deny_all ON wallets
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (false);

-- ---------------------------------------------------------------------------
-- spending_rules table
--
-- Spending rules (budget caps, service allowlists, auto-charge thresholds)
-- could be read or written by a malicious anon caller to disable safety
-- guardrails. Deny all non-service-role access.
-- ---------------------------------------------------------------------------

CREATE POLICY spending_rules_anon_deny_all ON spending_rules
  AS RESTRICTIVE
  FOR ALL
  TO anon
  USING (false);

CREATE POLICY spending_rules_authenticated_deny_all ON spending_rules
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (false);

-- =============================================================================
-- Future work (v0.2 dashboard with per-user JWT auth)
-- =============================================================================
--
-- When users authenticate with their own JWT (via Supabase Auth), replace the
-- "authenticated_deny_all" policies above with scoped ones such as:
--
--   CREATE POLICY users_owner_select ON users
--     FOR SELECT TO authenticated
--     USING (auth.uid() = id);
--
--   CREATE POLICY audit_logs_owner_select ON audit_logs
--     FOR SELECT TO authenticated
--     USING (
--       user_id = (SELECT id FROM users WHERE id = auth.uid())
--     );
--
-- Writing to users / spending_rules from authenticated clients should go
-- through a Postgres function with SECURITY DEFINER rather than direct
-- table grants, so that server-side validation (e.g. verifying a new
-- mcp_token is truly random before storing it) cannot be bypassed.
-- =============================================================================
