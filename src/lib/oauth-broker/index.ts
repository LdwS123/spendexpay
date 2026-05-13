/**
 * OAuth broker — pre-authorized "Continue with X" on behalf of the user.
 *
 * SCAFFOLD ONLY. The real OAuth code/refresh exchanges, scope checks, and
 * cross-provider quirks all land in a follow-up pass. Each exported function
 * is intentionally stubbed with TODO comments so the surface is callable
 * (and importable from `src/tools/grant-oauth-to-service.ts` and the
 * dashboard callback route) without yet performing any HTTP work.
 *
 * Why an explicit broker layer instead of letting every signup playbook
 * roll its own OAuth dance:
 *
 *   1. The user authorizes Spendex ONCE during onboarding. From then on,
 *      every downstream "Continue with GitHub/Google" button is granted
 *      transparently by the broker — never another redirect, never another
 *      consent screen, never leaving the chat.
 *
 *   2. Refresh tokens are long-lived secrets. Centralizing them in a single
 *      AES-256-GCM-encrypted table (`oauth_connections`) keeps the blast
 *      radius of any future bug small and the audit trail crisp.
 *
 *   3. Access tokens are short-lived but expensive to refresh. The broker
 *      caches the unexpired access_token_encrypted on the same row and
 *      only hits the provider when it has actually expired.
 *
 * Encryption MUST go through `encryptSecret` / `decryptSecret` from
 * `src/lib/crypto.ts` — same AES-256-GCM, same MANAGED_ACCOUNT_ENCRYPTION_KEY,
 * same on-disk layout as `managed_accounts.password_encrypted`. Anything else
 * fragments the key surface and complicates rotation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Closed set of OAuth providers the broker knows how to drive. Matches the
 * `oauth_provider` enum declared in supabase/migrations/008_oauth_broker.sql.
 * Add a new value here AND in the DB enum AND in the per-provider client
 * factory before shipping support for it.
 */
export type OAuthProvider = "github" | "google";

/**
 * Row shape returned by `handleCallback`. Ciphertexts are NOT exposed — the
 * caller only sees the metadata needed to render a "Connected as @kokabuildsf"
 * row on the dashboard. The plaintext tokens never leave the broker.
 */
export interface OAuthConnection {
  id: string;
  user_id: string;
  provider: OAuthProvider;
  provider_user_id: string;
  provider_username: string | null;
  scopes: string[];
  connected_at: string;
  revoked_at: string | null;
}

// ---------------------------------------------------------------------------
// Zod input schemas — colocated with the broker so callers (MCP tools, the
// dashboard callback route) validate against the same source of truth. Keep
// these exported so test code can drive them directly without re-declaring.
// ---------------------------------------------------------------------------

export const ConnectInput = z.object({
  user_id: z.string().uuid(),
  provider: z.enum(["github", "google"]),
});

export const HandleCallbackInput = z.object({
  provider: z.enum(["github", "google"]),
  code: z.string().min(1),
  // The opaque CSRF state value the dashboard handed to the provider on
  // `connect()`. Verifying it on callback is what keeps an attacker from
  // tricking a logged-in user into binding the attacker's GitHub account.
  state: z.string().min(1),
});

export const GetAccessTokenInput = z.object({
  user_id: z.string().uuid(),
  provider: z.enum(["github", "google"]),
  // Scopes the caller needs RIGHT NOW. If the stored connection lacks any of
  // them, the broker must refuse rather than silently degrade — the agent
  // should call `connect()` again to re-grant with the wider scope.
  scopes: z.array(z.string().min(1)).default([]),
});

export const RevokeInput = z.object({
  user_id: z.string().uuid(),
  provider: z.enum(["github", "google"]),
});

// ---------------------------------------------------------------------------
// connect — start the OAuth dance
// ---------------------------------------------------------------------------

/**
 * Begin a new OAuth grant for `userId` against `provider`. Returns the
 * authorize URL the user clicks during onboarding (the ONE time they leave
 * the chat surface — by design, this is the entire point of the broker).
 *
 * Today: returns a placeholder URL. The follow-up pass will:
 *   - Generate a CSRF-safe `state` value, persist it server-side keyed by
 *     userId so `handleCallback` can verify it.
 *   - Build the provider-specific authorize URL with the right scopes,
 *     redirect_uri (dashboard `/api/oauth/callback`), and PKCE challenge.
 *   - Honor a `prompt=consent` parameter so re-grants always show the
 *     scope screen (otherwise GitHub silently re-uses prior scopes).
 */
export async function connect(
  userId: string,
  provider: OAuthProvider
): Promise<{ authorize_url: string }> {
  ConnectInput.parse({ user_id: userId, provider });

  // TODO(oauth-broker): generate + persist CSRF `state` (e.g. signed JWT or
  // a server-side row keyed by userId with a 10-minute TTL).
  // TODO(oauth-broker): build the real authorize URL using
  // OAUTH_{GITHUB,GOOGLE}_CLIENT_ID + the scopes required for the downstream
  // grant. For Google, append `access_type=offline&prompt=consent` so the
  // refresh token is actually issued.
  // TODO(oauth-broker): wire PKCE for the providers that support it.
  console.error(
    `[oauth-broker] connect() stub called for user=${userId} provider=${provider}`
  );

  return { authorize_url: `https://example.invalid/oauth/${provider}/stub` };
}

// ---------------------------------------------------------------------------
// handleCallback — exchange code → tokens → persisted connection
// ---------------------------------------------------------------------------

/**
 * Backend handler for the OAuth redirect. The dashboard route at
 * `dashboard/src/app/api/oauth/callback` invokes this with the `code` and
 * `state` query params the provider just sent back. We:
 *
 *   1. Verify `state` matches what `connect()` persisted (CSRF defense).
 *   2. POST `code` to the provider's token endpoint with the client secret
 *      to receive `{ access_token, refresh_token, expires_in, scope }`.
 *   3. Encrypt both tokens with AES-256-GCM and upsert into
 *      `oauth_connections`. The row is keyed by
 *      (user_id, provider, provider_user_id) so re-connecting the same
 *      account refreshes the tokens in place rather than spawning duplicates.
 *   4. Return the metadata so the dashboard can redirect the user back to
 *      `/dashboard/settings/connections` with a success banner.
 */
export async function handleCallback(
  provider: OAuthProvider,
  code: string,
  state: string
): Promise<OAuthConnection> {
  HandleCallbackInput.parse({ provider, code, state });

  // TODO(oauth-broker): verify `state` against the value persisted in
  // `connect()`; reject on mismatch or expiry.
  // TODO(oauth-broker): POST to provider token endpoint with grant_type=authorization_code
  // using OAUTH_{GITHUB,GOOGLE}_CLIENT_SECRET. Strip the secret from any log line.
  // TODO(oauth-broker): fetch /user (GitHub) or /userinfo (Google) to resolve
  // provider_user_id + provider_username.
  // TODO(oauth-broker): encrypt access + refresh tokens via encryptSecret()
  // from src/lib/crypto.ts and upsert into oauth_connections.
  console.error(
    `[oauth-broker] handleCallback() stub called for provider=${provider}`
  );

  throw new Error(
    "oauth-broker.handleCallback: not yet implemented — see TODOs in src/lib/oauth-broker/index.ts"
  );
}

// ---------------------------------------------------------------------------
// getAccessToken — short-lived token for a single downstream grant
// ---------------------------------------------------------------------------

/**
 * Return a short-lived access token for `provider` bound to `userId`. Used
 * by `grant_oauth_to_service` so the agent can complete a downstream
 * "Continue with X" handshake in the host's browser tool.
 *
 * Refresh policy: if the cached `access_token_encrypted` exists and
 * `access_token_expires_at` is more than ~60 seconds in the future, return
 * it directly. Otherwise POST the refresh token to the provider, decrypt
 * the response, re-encrypt the new access token, and persist before
 * returning. The refresh token itself is rotated only when the provider
 * returns a new one (GitHub: never; Google: sometimes).
 *
 * Scope check is strict: if the requested scope set is not a subset of the
 * scopes on the stored connection, refuse and surface "reconnect required".
 * Silent scope upgrades would defeat the consent model.
 */
export async function getAccessToken(
  userId: string,
  provider: OAuthProvider,
  scope: string[] = []
): Promise<string> {
  GetAccessTokenInput.parse({ user_id: userId, provider, scopes: scope });

  // TODO(oauth-broker): look up the active oauth_connections row for
  // (userId, provider) WHERE revoked_at IS NULL.
  // TODO(oauth-broker): verify `scope ⊆ row.scopes`. Refuse otherwise.
  // TODO(oauth-broker): if cached access_token_encrypted is still valid,
  // decryptSecret() and return.
  // TODO(oauth-broker): otherwise refresh: POST refresh_token to provider
  // /token endpoint, encrypt new access token, write back to the same row.
  // TODO(oauth-broker): NEVER log the returned token, even on success.
  console.error(
    `[oauth-broker] getAccessToken() stub called for user=${userId} provider=${provider}`
  );

  throw new Error(
    "oauth-broker.getAccessToken: not yet implemented — see TODOs in src/lib/oauth-broker/index.ts"
  );
}

// ---------------------------------------------------------------------------
// revoke — disconnect a provider
// ---------------------------------------------------------------------------

/**
 * Mark the active connection for (userId, provider) as revoked. Idempotent:
 * calling twice is a no-op. Does NOT delete the row — keeping it around as
 * tombstone is useful for audit ("when did the user disconnect?").
 *
 * Best-effort hits the provider's revocation endpoint too so the refresh
 * token is invalidated upstream — but a provider-side failure does NOT
 * prevent the DB-side revocation from completing. The Spendex-side state
 * is the source of truth for whether the broker will ever use the token
 * again.
 */
export async function revoke(
  userId: string,
  provider: OAuthProvider
): Promise<void> {
  RevokeInput.parse({ user_id: userId, provider });

  // TODO(oauth-broker): UPDATE oauth_connections SET revoked_at = now()
  // WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL.
  // TODO(oauth-broker): best-effort POST to provider revocation endpoint
  // (GitHub: DELETE /applications/{client_id}/grant; Google: POST /revoke).
  // Swallow provider errors — DB revocation is authoritative.
  console.error(
    `[oauth-broker] revoke() stub called for user=${userId} provider=${provider}`
  );
}
