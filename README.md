```
 ____                       _              ____
/ ___| _ __   ___ _ __   __| | _____  __  |  _ \ __ _ _   _
\___ \| '_ \ / _ \ '_ \ / _` |/ _ \ \/ /  | |_) / _` | | | |
 ___) | |_) |  __/ | | | (_| |  __/>  <   |  __/ (_| | |_| |
|____/| .__/ \___|_| |_|\__,_|\___/_/\_\  |_|   \__,_|\__, |
      |_|                                              |___/
```

# Spendex Pay

> **The agent that lives in your agents.**
> Install once. Your AI agents can sign up to any service and pay for it — within the rules you set.

[![npm version](https://img.shields.io/npm/v/@spendexai/mcp.svg)](https://www.npmjs.com/package/@spendexai/mcp)
[![license](https://img.shields.io/npm/l/@spendexai/mcp.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-322%20passing-00e5b4.svg)](#)
[![node](https://img.shields.io/node/v/@spendexai/mcp.svg)](package.json)

---

## The wall every AI agent hits

You're coding with Claude Code at 2am. You ask it to deploy your app to production.
Vercel says: *"Free tier exceeded. Upgrade to Pro for $20/month."*

Your agent stops. You sigh. You sign in to vercel.com, find your card, type the numbers,
come back. You've lost five minutes — and you've lost the flow.

**This happens every time your agent needs to:**

- Deploy on Vercel after the free tier (€20/mo) — *agent stops, you upgrade manually*
- Top up Modal GPU credits (€50) — *agent stops, you go to modal.com*
- Spin up an OpenAI API key (€10) — *agent stops, you create the account*
- Buy something on Amazon (€89) — *agent stops, you type your card*

**Spendex Pay removes the wall.** Install once in your agent (Claude Code, Cursor,
ChatGPT, Cowork, or any MCP host). Configure your spending rules once. From then on,
your agent has:

- 🪪 **Identity** — it can sign up for new services on your behalf, with your explicit consent
- 💳 **Wallet** — a Stripe Issuing virtual card pays for everything, within the limits you set
- 🛡️ **Rules** — per-transaction caps, monthly budget, allowed merchants — enforced by Stripe in <2s, not by application code

You manage **one** relationship: with Spendex.
Spendex manages every relationship with every service your agent ever touches.

---

## Three phases of agent commerce

| Phase | When | Who | Connected services |
|---|---|---|---|
| **Now** | 2026 | Developers using coding agents (Claude Code, Cursor, Codex) | Vercel, OpenAI, Anthropic, Modal, GitHub, Cloudflare |
| **Next** | 2027 | Consumers using personal agents (Cowork, ChatGPT, OpenClaw) | Netflix, Spotify, Uber, Airbnb, Amazon |
| **Eventually** | 2028+ | Agents themselves are the customers — companies issue Spendex accounts to their AI workers with budget caps | the entire agent economy |

We start where the pain is sharpest: developers. We expand wherever an agent needs a wallet.

---

## Quick install

> Detailed per-client instructions live in [`INSTALL.md`](./INSTALL.md). Below is the 30-second version for each host.

<details>
<summary><b>Claude Code (CLI)</b></summary>

```bash
claude mcp add spendex
```

Or paste into `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "spendex": {
      "command": "npx",
      "args": ["-y", "@spendexai/mcp"],
      "env": { "SPENDEX_TOKEN": "spx_..." }
    }
  }
}
```

Restart Claude Code to pick up the new server.
</details>

<details>
<summary><b>Cursor</b></summary>

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "spendex": {
      "command": "npx",
      "args": ["-y", "@spendexai/mcp"],
      "env": { "SPENDEX_TOKEN": "spx_..." }
    }
  }
}
```

Open the command palette and run **MCP: Restart Servers**.
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "spendex": {
      "command": "npx",
      "args": ["-y", "@spendexai/mcp"],
      "env": { "SPENDEX_TOKEN": "spx_..." }
    }
  }
}
```

Quit and relaunch Claude Desktop.
</details>

<details>
<summary><b>claude.ai (web)</b></summary>

1. Open **Settings → Connectors → Add MCP server**.
2. URL: `https://spendex-mcp.fly.dev/mcp`
3. Auth header: `Authorization: Bearer spx_...`
4. Save. The wallet tools appear in the next conversation.
</details>

<details>
<summary><b>ChatGPT (custom GPT or Operator)</b></summary>

1. In your custom GPT, open **Configure → Actions → Add MCP server**.
2. URL: `https://spendex-mcp.fly.dev/mcp`
3. Auth: bearer token `spx_...` (issued from the Spendex dashboard).
4. Save and test in a new chat.
</details>

Get your `SPENDEX_TOKEN` from <https://spendexai.com/dashboard/settings>.

---

## What your agent can do

23 MCP tools, grouped by purpose. **Primary** is what you want to use; **Introspection** is for self-checks; **Legacy** is per-merchant fallbacks kept for backwards compatibility.

### Primary (7) — universal surface

| Tool | Purpose |
|---|---|
| `pay_for_service` | Pay for any service. Returns native API success or virtual card details. |
| `signup_to_service` | Create an account at any service under the user's identity. |
| `request_user_consent` | Ask the user inline before acting. Returns a markdown prompt + `consent_id`. |
| `submit_consent_decision` | Submit the user's reply (A/B/C/D) to unlock the pending action. |
| `check_consent_status` | Poll a pending consent request. |
| `get_verification_email` | Read the most recent verification email from the wallet's alias inbox. |
| `complete_signup` | Finalize a signup once the verification link has been confirmed. |

### Introspection (3) — agent self-monitoring

| Tool | Purpose |
|---|---|
| `check_balance` | Wallet balance + month-to-date spend + monthly budget. |
| `check_spending_rules` | Current rules (consent mode, per-tx cap, budget, trusted services). |
| `list_supported_services` | List the services with native integrations. |

### Legacy fallback (13) — per-merchant tools

Kept for backwards compatibility. Prefer `pay_for_service` for new integrations.

| Tool | Service |
|---|---|
| `deploy_to_vercel` | Vercel |
| `deploy_to_railway` | Railway |
| `deploy_to_flyio` | Fly.io |
| `deploy_to_render` | Render |
| `deploy_to_netlify` | Netlify |
| `deploy_to_cloudflare` | Cloudflare Pages / Workers |
| `run_modal` | Modal GPU |
| `run_on_replicate` | Replicate |
| `run_huggingface_inference` | Hugging Face Inference API |
| `subscribe_to_service` | Recurring charge against the wallet |
| `add_service_credits` | Top up an existing service balance |
| `generate_gamma_presentation` | Gamma |
| `provision_supabase_project` | Supabase |

---

## How it works

```
 ┌──────────────┐                                 ┌──────────────────┐
 │  Your agent  │   pay_for_service(...)          │   Spendex MCP    │
 │ (Claude Code,│ ──────────────────────────────▶ │ (stdio or HTTPS) │
 │  Cursor, ...)│                                 └─────────┬────────┘
 └──────────────┘                                           │
        ▲                                                   │ rules + balance
        │ "Pay $20 to                                       │ check
        │  Vercel Pro?"                                     ▼
        │                                          ┌────────────────┐
        │                                          │ Stripe Issuing │
        │                                          │  virtual card  │
        │                                          └────────┬───────┘
        │                                                   │
        │                                       authorization request
        │                                                   │
        │                                                   ▼
        │                                          ┌────────────────┐
        │                                          │ Spendex webhook│
        │                                          │  <2s decision  │
        │                                          └────────┬───────┘
        │                                                   │
        │           card detail / approval                  │ approve / decline
        └───────────────────────────────────────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  Audit log (DB)  │
                       └──────────────────┘
```

1. Agent calls `pay_for_service`.
2. MCP server checks the user's spending rules and current balance.
3. If a charge is needed, Stripe Issuing sends an authorization request to the Spendex webhook.
4. The webhook approves or declines in under 2 seconds based on the rules.
5. Every authorization (approved or declined) is written to an immutable audit log.

---

## Security

- **MCP tokens are hashed with HMAC-SHA256.** Only the salted hash is stored in the database. The raw token never sits in our DB.
- **Credentials are encrypted at rest with AES-256-GCM.** Each managed-account row holds an encrypted password, never plaintext.
- **Per-transaction caps and monthly budgets are wired into Stripe Issuing**, not enforced in application code. Even if the agent goes rogue, charges above your limits are declined by Stripe in real time.
- **MCC blocklist.** The card is restricted to dev-tools / cloud merchant categories. Charges from anywhere else (e.g. gambling, retail) are declined automatically.
- **Emergency stop.** Set `EMERGENCY_STOP=true` in the process env to freeze all payment processing immediately. The flag is read on every authorization (not cached), so no restart is required.
- **`stdout` is reserved for the MCP protocol.** All debug output goes to `stderr`. Card numbers, CVCs, secret keys, and MCP tokens are never logged anywhere — stdout, stderr, Sentry, analytics.
- **Audit log every authorization.** Approved, declined, and settled events are all persisted. Dispute resolution is one query away.

---

## Deployment

The wallet ships in two flavours from a single codebase: an npm package (stdio, runs locally on the user's machine) and a Streamable HTTP service (deployed to Fly.io, used by web-based hosts like claude.ai and ChatGPT).

### Publish to npm

```bash
npm login
npm run build && npm test
npm publish --access public
npx @spendexai/mcp@latest --help   # smoke test the published artifact
```

### Deploy the HTTP transport to Fly.io

```bash
fly auth login
fly launch --copy-config --no-deploy
fly secrets set \
  SUPABASE_URL=... \
  SUPABASE_SERVICE_ROLE_KEY=... \
  STRIPE_SECRET_KEY=... \
  STRIPE_WEBHOOK_SECRET=... \
  STRIPE_ISSUING_WEBHOOK_SECRET=... \
  MCP_TOKEN_SALT=... \
  MANAGED_ACCOUNT_ENCRYPTION_KEY=... \
  NOTIFY_INTERNAL_TOKEN=...
fly deploy
fly status
curl https://spendex-mcp.fly.dev/health   # → { "status": "ok", "version": "0.1.0" }
```

Full runbook (DNS, Stripe webhook, Resend, Supabase migrations, smoke tests) lives in [`DEPLOY.md`](./DEPLOY.md).

---

## Development

```bash
git clone https://github.com/spendexai/mcp.git
cd mcp
cp .env.example .env       # fill in test keys or set SPENDEX_DEV=true
npm install
npm run dev                # tsx watch, stdio transport, hot reload
```

### Test it without Claude Code

```bash
npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | SPENDEX_DEV=true node dist/index.js 2>/dev/null
```

### Run the test suite

```bash
npm test                   # vitest, 309 tests
npm run lint               # tsc --noEmit, type-only check
```

### Dev mode

Set `SPENDEX_DEV=true` in your environment to bypass Stripe and Supabase entirely. Every tool call returns a simulated success. Use this when iterating on tool schemas — no real money moves, no real DB writes.

### Database migrations

Canonical SQL migrations live in [`/migrations/`](./migrations/). The
[`/supabase/migrations/`](./supabase/migrations/) directory is an exact
mirror kept in sync for the Supabase CLI — never edit it directly; copy
from `/migrations/` instead.

Apply migrations in order **001 → 007** on a fresh Supabase project. See
[`DEPLOY.md`](./DEPLOY.md#4-supabase--apply-migrations) for the full
runbook and a per-file changelog.

---

## License

[MIT](./LICENSE) © Spendex AI

---

## Links

- **Homepage:** <https://spendexai.com>
- **Dashboard:** <https://app.spendexai.com/dashboard>
- **Docs:** <https://spendexai.com/docs>
- **HTTP MCP endpoint:** <https://spendex-mcp.fly.dev/mcp>
- **Issues:** <https://github.com/spendexai/mcp/issues>
- **Support:** support@spendexai.com
