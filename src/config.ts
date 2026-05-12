// When SPENDEX_DEV=true, missing credentials are replaced with placeholders
// so the server can start without real Stripe/Supabase accounts.
// All tool calls return simulated responses — no real money moves.
export const DEV_MODE = process.env["SPENDEX_DEV"] === "true";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    if (DEV_MODE) return `dev_placeholder_${name}`;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Validate all required environment variables are present and well-formed.
 *
 * Must only be called from main() — not at module load time — so that
 * DEV_MODE can be read fresh and so that import-time side effects don't
 * block test files from loading config.ts.
 *
 * Reads process.env.SPENDEX_DEV fresh on each call so that tests can
 * control the flag without re-importing the module.
 */
export function validateConfig(): void {
  // In dev mode, missing credentials are expected and the server runs with
  // placeholders.  Skip all validation.
  if (process.env["SPENDEX_DEV"] === "true") return;

  const errors: string[] = [];

  const supabaseUrl = process.env["SUPABASE_URL"];
  if (!supabaseUrl) {
    errors.push(
      "Missing SUPABASE_URL — set it to your Supabase project URL (https://xxx.supabase.co)"
    );
  } else if (!supabaseUrl.startsWith("https://")) {
    errors.push(
      "SUPABASE_URL must start with 'https://' — check your Supabase project settings"
    );
  }

  const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? process.env["SUPABASE_SERVICE_KEY"];
  if (!supabaseKey) {
    errors.push(
      "Missing SUPABASE_SERVICE_ROLE_KEY — set it to your Supabase service role key"
    );
  }

  const stripeKey = process.env["STRIPE_SECRET_KEY"];
  if (!stripeKey) {
    errors.push(
      "Missing STRIPE_SECRET_KEY — set it to your Stripe secret key (sk_live_…, sk_test_… or rk_test_…)"
    );
  } else if (!stripeKey.startsWith("sk_") && !stripeKey.startsWith("rk_")) {
    errors.push(
      "STRIPE_SECRET_KEY must start with 'sk_' or 'rk_' — check your Stripe dashboard"
    );
  }

  const stripeWebhook = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!stripeWebhook) {
    errors.push(
      "Missing STRIPE_WEBHOOK_SECRET — set it to your Stripe webhook signing secret (whsec_…)"
    );
  } else if (!stripeWebhook.startsWith("whsec_")) {
    errors.push(
      "STRIPE_WEBHOOK_SECRET must start with 'whsec_' — check your Stripe webhook settings"
    );
  }

  const mcpTokenSalt = process.env["MCP_TOKEN_SALT"];
  if (!mcpTokenSalt) {
    errors.push(
      "Missing MCP_TOKEN_SALT — set it to a long random string used as the HMAC " +
        "key when hashing MCP tokens before lookup. Must match the value the " +
        "dashboard used when issuing tokens."
    );
  } else if (mcpTokenSalt.length < 16) {
    errors.push(
      "MCP_TOKEN_SALT is too short — use at least 16 characters of entropy " +
        "(e.g. `openssl rand -hex 32`)."
    );
  }

  if (errors.length > 0) {
    throw new Error(
      "\n[Spendex Pay] Configuration error — fix before starting:\n" +
        errors.join("\n")
    );
  }
}

export const config = {
  stripe: {
    // Lazy getters so importing config.ts never throws at module load time —
    // missing vars are only surfaced when the value is first accessed (at
    // runtime, inside a tool handler) or via validateConfig() in main().
    get secretKey() { return requireEnv("STRIPE_SECRET_KEY"); },
    get webhookSecret() { return requireEnv("STRIPE_WEBHOOK_SECRET"); },
  },
  supabase: {
    get url() { return requireEnv("SUPABASE_URL"); },
    get serviceRoleKey() { return requireEnv("SUPABASE_SERVICE_ROLE_KEY"); },
  },

  // HMAC-SHA256 key used to hash inbound MCP tokens before looking them up
  // in the `users.mcp_token` column. The dashboard that issues tokens MUST
  // use the same salt so the hash matches at lookup time. Stored as a hex
  // string in the DB column.
  mcp: {
    get tokenSalt() { return requireEnv("MCP_TOKEN_SALT"); },
  },

  // Optional test-mode flag. When SPENDEX_TEST_CHARGE=true, tools that
  // normally cost $0 (Vercel deploys on the Pro plan, etc.) charge a small
  // symbolic amount instead so the full Stripe payment flow can be exercised
  // end-to-end against test keys. Re-read on every access so toggling the
  // env var takes effect without a restart.
  get testChargeEnabled() {
    return process.env["SPENDEX_TEST_CHARGE"] === "true";
  },

  // Optional providers — only required when a user has configured that method
  paypal: {
    get clientId() { return requireEnv("PAYPAL_CLIENT_ID"); },
    get clientSecret() { return requireEnv("PAYPAL_CLIENT_SECRET"); },
    sandbox: process.env["PAYPAL_SANDBOX"] !== "false",
  },
  coinbase: {
    get commerceApiKey() { return requireEnv("COINBASE_COMMERCE_API_KEY"); },
  },
  circle: {
    get apiKey() { return requireEnv("CIRCLE_API_KEY"); },
    get treasuryWalletId() { return requireEnv("CIRCLE_TREASURY_WALLET_ID"); },
    sandbox: process.env["CIRCLE_SANDBOX"] !== "false",
  },

  // Re-read on every access so setting EMERGENCY_STOP=true on a live server
  // takes effect instantly without a restart.
  get emergencyStop() { return process.env["EMERGENCY_STOP"] === "true"; },

  // Public base URL of the Spendex dashboard app. Used by the consent layer
  // to fire fire-and-forget notification POSTs to /api/notify/consent. Read
  // fresh on every access so the env var can be updated without restart.
  get dashboardUrl(): string | null {
    const v = process.env["SPENDEX_DASHBOARD_URL"];
    return v && v.length > 0 ? v.replace(/\/+$/, "") : null;
  },

  // Shared secret sent in the `x-internal-token` header on server-to-server
  // POSTs to the dashboard's /api/notify/consent endpoint. MUST match the
  // dashboard's NOTIFY_INTERNAL_TOKEN env var or every notification will be
  // rejected with 401. Read fresh on every access so the secret can be
  // rotated without restarting the MCP server.
  get notifyInternalToken(): string | null {
    const v = process.env["NOTIFY_INTERNAL_TOKEN"];
    return v && v.length > 0 ? v : null;
  },
};
