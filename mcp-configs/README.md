# Spendex Pay — MCP Client Installation Guide

Spendex Pay is a local MCP server that runs on your machine via stdio. Your coding agent (Claude Code, Cursor, Windsurf) spawns it as a subprocess and calls its tools to pay for dev services — Vercel deploys, GPU jobs, and more — without interrupting your flow.

**Requirements:** Node.js 20 or later.

---

## Table of Contents

1. [Get your credentials from the Spendex dashboard](#1-get-your-credentials-from-the-spendex-dashboard)
2. [Get a Vercel API token](#2-get-a-vercel-api-token)
3. [Install for Claude Code](#3-install-for-claude-code)
4. [Install for Cursor](#4-install-for-cursor)
5. [Install for Windsurf](#5-install-for-windsurf)
6. [Test the connection](#6-test-the-connection)
7. [Security notes](#7-security-notes)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Get your credentials from the Spendex dashboard

1. Sign in at **https://spendexai.com/dashboard**.
2. Go to **Settings > API Keys**.
3. Copy the following values — you will paste them into your MCP config:

   | Value | Where to find it |
   |---|---|
   | `STRIPE_SECRET_KEY` | Settings > Payments > Stripe secret key |
   | `STRIPE_WEBHOOK_SECRET` | Settings > Payments > Webhook signing secret |
   | `SUPABASE_URL` | Settings > API Keys > Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Settings > API Keys > Service role key |

> Use `sk_test_...` keys while testing and switch to `sk_live_...` only when you are ready to charge a real card.

---

## 2. Get a Vercel API token

The MCP server calls Vercel on your behalf. You need to give it a token with deploy permissions.

1. Go to **https://vercel.com/account/tokens**.
2. Click **Create Token**.
3. Name it `spendex-pay`, set the scope to the team or personal account you deploy from, and set an expiry that fits your security policy (90 days is a good default).
4. Copy the token.
5. Paste it into the Spendex dashboard at **Settings > Integrations > Vercel API Token**.

The dashboard stores the token encrypted and passes it to the MCP server at runtime. You do not need to add it to the MCP config file directly.

---

## 3. Install for Claude Code

Claude Code reads its MCP server list from:

- **macOS / Linux:** `~/.claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

### Steps

1. Open (or create) `~/.claude/claude_desktop_config.json`.
2. Merge in the contents of `mcp-configs/claude-code.json` from this repo.
3. Replace every placeholder value with your real credentials:

```json
{
  "mcpServers": {
    "spendex-pay": {
      "command": "npx",
      "args": ["-y", "spendex-pay"],
      "env": {
        "STRIPE_SECRET_KEY": "sk_live_YOUR_KEY_HERE",
        "STRIPE_WEBHOOK_SECRET": "whsec_YOUR_SECRET_HERE",
        "SUPABASE_URL": "https://YOUR_PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR_SERVICE_ROLE_KEY",
        "EMERGENCY_STOP": "false"
      }
    }
  }
}
```

4. If the file already has other MCP servers, add `"spendex-pay": { ... }` inside the existing `"mcpServers"` object — do not replace the whole file.
5. Save the file and restart Claude Code.

---

## 4. Install for Cursor

Cursor reads MCP servers from a file inside your project or your home directory:

- **Per-project:** `YOUR_PROJECT/.cursor/mcp.json`
- **Global:** `~/.cursor/mcp.json`

Use the per-project file if you only want Spendex Pay active in specific repos. Use the global file to have it available everywhere.

### Steps

1. Open (or create) `.cursor/mcp.json` in your project root, or `~/.cursor/mcp.json` for a global install.
2. Merge in the contents of `mcp-configs/cursor.json` from this repo.
3. Replace every placeholder value with your real credentials:

```json
{
  "mcpServers": {
    "spendex-pay": {
      "command": "npx",
      "args": ["-y", "spendex-pay"],
      "env": {
        "STRIPE_SECRET_KEY": "sk_live_YOUR_KEY_HERE",
        "STRIPE_WEBHOOK_SECRET": "whsec_YOUR_SECRET_HERE",
        "SUPABASE_URL": "https://YOUR_PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR_SERVICE_ROLE_KEY",
        "EMERGENCY_STOP": "false"
      }
    }
  }
}
```

4. Save the file and restart Cursor (or open the Command Palette and run **MCP: Restart Servers**).

---

## 5. Install for Windsurf

Windsurf reads MCP servers from:

- **macOS / Linux:** `~/.codeium/windsurf/mcp_config.json`
- **Windows:** `%APPDATA%\Codeium\windsurf\mcp_config.json`

### Steps

1. Open (or create) `~/.codeium/windsurf/mcp_config.json`.
2. Merge in the contents of `mcp-configs/windsurf.json` from this repo.
3. Replace every placeholder value with your real credentials:

```json
{
  "mcpServers": {
    "spendex-pay": {
      "command": "npx",
      "args": ["-y", "spendex-pay"],
      "env": {
        "STRIPE_SECRET_KEY": "sk_live_YOUR_KEY_HERE",
        "STRIPE_WEBHOOK_SECRET": "whsec_YOUR_SECRET_HERE",
        "SUPABASE_URL": "https://YOUR_PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR_SERVICE_ROLE_KEY",
        "EMERGENCY_STOP": "false"
      }
    }
  }
}
```

4. Save the file. Open Windsurf Settings > MCP and click **Reload** to pick up the new server.

---

## 6. Test the connection

After restarting your client, ask your agent:

> "List my Spendex Pay tools"

The agent should respond with the available tools, starting with `deploy_to_vercel`. If it does, the server is running and authenticated correctly.

You can also ask:

> "What can Spendex Pay do?"

The server will describe its current tool set (v0.1: Vercel deploy).

---

## 7. Security notes

- **Never commit a config file that contains real keys.** Add the config file to `.gitignore` if it lives inside a repo, or keep it in your home directory outside any repo.
- **Use environment variable expansion** if your client supports it (some clients let you reference shell env vars like `${STRIPE_SECRET_KEY}`), so the JSON file itself never contains the raw secret.
- **Use test keys (`sk_test_...`) while developing.** Switch to live keys only when you have end-to-end tested the full payment flow.
- **Set `EMERGENCY_STOP=true`** to instantly disable all payment processing without touching anything else. Useful if you suspect a runaway agent or compromised key.
- **Rotate keys immediately** if you accidentally expose them (push to a public repo, paste in a chat, etc.). Stripe and Supabase both have one-click key rotation in their dashboards.
- The `SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security. Treat it with the same care as a database root password.

---

## 8. Troubleshooting

### Server not starting

**Symptom:** The agent says the tool is unavailable, or the MCP server list shows `spendex-pay` as disconnected.

**Checks:**
- Run `node --version` in your terminal. It must be 20 or later. If not, install Node.js from https://nodejs.org.
- Run `npx -y spendex-pay` manually in your terminal. You should see `Spendex Pay MCP server running on stdio` on stderr. Any error here explains why the client cannot start it.
- Confirm the JSON in your config file is valid. A trailing comma or a missing brace silently breaks the whole config. Run it through https://jsonlint.com or `node -e "JSON.parse(require('fs').readFileSync('/path/to/config.json','utf8'))"`.
- Make sure there are no extra spaces or newlines inside the key values.

### Invalid token / authentication error

**Symptom:** The server starts but tools fail immediately with an authentication error.

**Checks:**
- Verify `STRIPE_SECRET_KEY` starts with `sk_test_` (test mode) or `sk_live_` (live mode) and was copied without truncation.
- Verify `SUPABASE_SERVICE_ROLE_KEY` is the **service role** key, not the **anon** key. The service role key is longer and starts with `eyJ`.
- Check that `SUPABASE_URL` ends with `.supabase.co` and has no trailing slash.
- In the Spendex dashboard, confirm your account is active and not suspended.

### Payment fails

**Symptom:** The tool is called, a charge is attempted, but it fails and the deploy does not happen.

**Checks:**
- Check `EMERGENCY_STOP`. If it is set to `"true"`, all payments are blocked by design. Set it back to `"false"` to re-enable.
- In test mode, use Stripe test card numbers (e.g. `4242 4242 4242 4242`). Real card numbers are rejected in test mode.
- Open the Stripe dashboard > Logs to see the exact error on the PaymentIntent. Common causes: card declined, insufficient funds, 3D Secure required.
- Confirm the amount does not exceed the `max_amount` limit configured in your Spendex dashboard (Settings > Spending Limits). The server will not auto-charge above your limit without explicit confirmation.
- Check the Supabase logs (dashboard > Logs > Postgres) to confirm the transaction was written to the audit table. If it was not written, the server may have crashed before the charge — check stderr output from the `npx` process.

### Webhook errors (Stripe)

**Symptom:** Payments succeed but the Spendex dashboard does not reflect them, or you see webhook errors in Stripe.

**Checks:**
- Confirm `STRIPE_WEBHOOK_SECRET` (`whsec_...`) matches the signing secret for the webhook endpoint registered in your Stripe dashboard.
- The webhook endpoint must be publicly reachable. For local development, use the Stripe CLI: `stripe listen --forward-to localhost:PORT/webhook`.
- Check Stripe dashboard > Developers > Webhooks > your endpoint > Recent deliveries for the exact failure reason.
