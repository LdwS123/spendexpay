# Installing Spendex Pay in your agent

> Your agent just hit Vercel's paywall. Here's how to wire Spendex in 60 seconds.

Spendex Pay is the wallet that lives inside your agents. Install once in the host of your choice and your agent gains a Stripe Issuing virtual card, a managed identity, and rules that hold the line — without you ever leaving the chat.

You'll need a `SPENDEX_TOKEN` (format: `spx_...`) from <https://spendexai.com/dashboard/settings>. Issue one token per device or per agent so you can rotate them independently.

**Two transports, one product:**

- **Local (stdio)** — the wallet runs on the user's machine as an `npx` subprocess. Used by desktop and CLI agents (Claude Code, Cursor, Claude Desktop). Lowest latency, no network round-trip for JSON-RPC.
- **Remote (Streamable HTTP)** — the wallet is hosted at `https://spendex-mcp.fly.dev/mcp`. Used by web-based agents (claude.ai, ChatGPT custom GPTs, Cowork). Nothing to install on the user's machine.

---

## Table of contents

1. [Claude Code (CLI)](#1-claude-code-cli)
2. [Cursor](#2-cursor)
3. [Claude Desktop](#3-claude-desktop)
4. [claude.ai (web)](#4-claudeai-web)
5. [ChatGPT (custom GPT / Operator)](#5-chatgpt-custom-gpt--operator)
6. [Cowork](#6-cowork)
7. [Verifying the install](#7-verifying-the-install)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Claude Code (CLI)

**Best for:** terminal coding agents that ship code and pay for cloud infra in the same session.

Claude Code reads MCP servers from two places:

| Scope | File | When to use |
|---|---|---|
| Project | `.mcp.json` at the repo root | The wallet is only active inside that project |
| User (global) | `~/.claude.json` | The wallet is active in every Claude Code session |

### Option A — the one-liner

```bash
claude mcp add spendex
```

This walks you through prompts and writes the entry to your user-level config.

### Option B — paste the JSON

Open `~/.claude.json` (or create it) and merge in:

```json
{
  "mcpServers": {
    "spendex": {
      "command": "npx",
      "args": ["-y", "@spendexai/mcp"],
      "env": {
        "SPENDEX_TOKEN": "spx_REPLACE_ME"
      }
    }
  }
}
```

For a project-scoped install, use `.mcp.json` at the repo root instead. Same shape.

### Restart

```bash
# Exit any running Claude Code session, then:
claude
```

### Verify it works

```bash
claude --print "Use Spendex to check my balance"
```

You should see the wallet reply with month-to-date spend and your monthly budget.

```
┌──────────────────────────────────────────────────────┐
│  Claude Code v… connected MCP servers: spendex ✓     │
│                                                      │
│  Tools available:                                    │
│    pay_for_service                                   │
│    signup_to_service                                 │
│    request_user_consent                              │
│    submit_consent_decision                           │
│    ... (24 total)                                    │
└──────────────────────────────────────────────────────┘
```

---

## 2. Cursor

**Best for:** IDE-driven agents that need a wallet while they refactor, deploy, and pay for SaaS in the same flow.

Cursor reads MCP servers from:

- **Per-project:** `<your-repo>/.cursor/mcp.json`
- **Global:** `~/.cursor/mcp.json`

### Steps

1. Open `~/.cursor/mcp.json` (or create it).
2. Paste:

   ```json
   {
     "mcpServers": {
       "spendex": {
         "command": "npx",
         "args": ["-y", "@spendexai/mcp"],
         "env": {
           "SPENDEX_TOKEN": "spx_REPLACE_ME"
         }
       }
     }
   }
   ```

3. Save the file.
4. Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **MCP: Restart Servers**.

### Verify it works

Open the Cursor chat and ask:

> "List my Spendex tools."

You should see `spendex` with a green dot under **Settings → MCP** and 24 tools available in the chat.

---

## 3. Claude Desktop

**Best for:** desktop agents handling longer-running work — overnight runs, scheduled refreshes, recurring subscriptions.

Claude Desktop reads its config from a per-OS path:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

### Steps

1. Quit Claude Desktop entirely (not just close the window — fully quit so the next launch re-reads the config).
2. Open the file above. If it doesn't exist, create it with `{}` as the initial content.
3. Merge in:

   ```json
   {
     "mcpServers": {
       "spendex": {
         "command": "npx",
         "args": ["-y", "@spendexai/mcp"],
         "env": {
           "SPENDEX_TOKEN": "spx_REPLACE_ME"
         }
       }
     }
   }
   ```

4. Save the file.
5. Relaunch Claude Desktop.

### Verify it works

A small hammer icon appears in the lower-right of the chat input. Click it — you should see the Spendex tools listed. Then ask:

> "Show me my Spendex spending rules."

The wallet should reply with your current consent mode, per-transaction cap, and monthly budget.

---

## 4. claude.ai (web)

**Best for:** browser-only users who don't want to install anything locally.

The web version of Claude doesn't spawn subprocesses on your machine — it speaks to MCP servers over HTTP. We host the wallet at a public URL for this case.

### Steps

1. Sign in at <https://claude.ai>.
2. Open **Settings → Connectors → Add MCP server**.
3. Fill in:

   | Field | Value |
   |---|---|
   | Name | `Spendex Pay` |
   | URL | `https://spendex-mcp.fly.dev/mcp` |
   | Auth | Bearer token |
   | Token | `spx_REPLACE_ME` (your `SPENDEX_TOKEN`) |

4. Click **Add**. The connector turns green when the handshake succeeds.

```
┌──────────────────────────────────────────────────────┐
│  Connectors                                          │
│  ┌────────────────────────────────────────────────┐  │
│  │ ● Spendex Pay                                  │  │
│  │   https://spendex-mcp.fly.dev/mcp              │  │
│  │   24 tools available                           │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### Verify it works

Open a new chat (no restart required) and ask:

> "What Spendex tools do you have?"

You should see the 24 wallet tools listed.

---

## 5. ChatGPT (custom GPT / Operator)

**Best for:** GPT builders and Operator users who want their automation to pay for things autonomously.

ChatGPT supports MCP servers through the custom GPT Actions surface. The connection is HTTP-based; the wallet's Fly.io endpoint serves it.

### Steps

1. Sign in at <https://chatgpt.com>.
2. **Create a GPT** (or open an existing one) and click **Configure → Actions → Add MCP server**.
3. Fill in:

   | Field | Value |
   |---|---|
   | Server URL | `https://spendex-mcp.fly.dev/mcp` |
   | Authentication | API Key (bearer) |
   | API Key | `spx_REPLACE_ME` |

4. Save the GPT.
5. Open a new chat with the GPT to test.

For ChatGPT Operator (the autonomous browser agent), the wallet appears in the tool sidebar after the first MCP handshake — the same URL + token works.

### Verify it works

In a new chat with the GPT, ask:

> "Check my Spendex balance."

The GPT should call `check_balance` and return the wallet's response inline.

---

## 6. Cowork

**Best for:** team workspaces where multiple human and AI agents share the same managed wallet.

Cowork hosts MCP servers through its workspace settings.

### Steps

1. Sign in to your Cowork workspace.
2. Open **Settings → Integrations → MCP servers → Add server**.
3. Fill in:

   | Field | Value |
   |---|---|
   | Display name | `Spendex Pay` |
   | Endpoint | `https://spendex-mcp.fly.dev/mcp` |
   | Auth header | `Authorization: Bearer spx_REPLACE_ME` |

4. Save. Cowork will perform an `initialize` handshake and list the available tools.

If you prefer to run the wallet locally instead, Cowork also supports stdio servers — use the same JSON block shown in the Claude Code section under the workspace's local-tools config.

### Verify it works

In a Cowork conversation, ask one of the workspace agents:

> "List my supported Spendex services."

The agent should call `list_supported_services` and return the merchants with native integrations.

---

## 7. Verifying the install

In any agent, ask:

> "List my Spendex Pay tools."

You should see 24 tool names returned, starting with `pay_for_service`. If you see them, you're done.

You can also exercise the wallet end-to-end with:

> "Use Spendex to check my balance."

The agent will call `check_balance` and the wallet will reply with the current balance, month-to-date spend, and your monthly budget.

---

## 8. Troubleshooting

The five errors we see most often, and how to fix each one.

### Error 1 — `command failed: ENOENT` (stdio hosts)

```
[error] spendex: command failed: ENOENT
```

**Cause:** Node isn't on the host's `PATH`, or it's older than v20.

**Fix:**
- Run `node --version`. The wallet requires Node 20+.
- Run `npx -y @spendexai/mcp` in your terminal manually. The server should print `Spendex Pay MCP server running on stdio` to stderr. Any other output explains the failure.
- On macOS, GUI apps don't inherit your shell's PATH. Install Node system-wide via the official installer or use `nvm-installer` rather than `nvm`.

### Error 2 — `handshake timed out` (HTTP hosts)

```
[error] Spendex Pay: handshake timed out
```

**Cause:** The URL is wrong, or the service is unreachable from the client.

**Fix:**
- `curl https://spendex-mcp.fly.dev/health` should return `{ "status": "ok" }`. If it doesn't, the service is down — check the status page.
- Make sure the URL ends with `/mcp` exactly. Some hosts auto-append paths and break the route.
- Corporate proxies sometimes block `*.fly.dev`. Try from a different network to confirm.

### Error 3 — `invalid_token`

```
[error] spendex.check_balance: invalid_token
```

**Cause:** The token was truncated, rotated, or is from a different deployment.

**Fix:**
- Tokens start with `spx_` and are 48+ characters. If yours is shorter, it was truncated when copied.
- Issue a fresh token from <https://spendexai.com/dashboard/settings> and update the agent config.
- The dashboard hashes tokens with the same `MCP_TOKEN_SALT` as the MCP server. If you've self-hosted the wallet, those two values must match.

### Error 4 — Invalid JSON in config file

```
[error] failed to parse mcp.json: Unexpected token } in JSON
```

**Cause:** A trailing comma, missing brace, or stray comment in the config.

**Fix:**
- Validate the file with:
  ```bash
  node -e "JSON.parse(require('fs').readFileSync('PATH','utf8'))"
  ```
- Strict JSON: no trailing commas, no `// comments`, double quotes only.
- If you merged config blocks by hand, double-check brace nesting around `mcpServers`.

### Error 5 — Tools don't appear after restart

**Cause:** The host didn't actually fully restart, or the config is in the wrong scope.

**Fix:**
- Fully quit the host (Claude Desktop: `Cmd+Q`, not the red close button).
- For Cursor, the command palette **MCP: Restart Servers** is more reliable than restarting the whole app.
- Confirm you wrote to the right config file. Project-scoped configs (`.mcp.json`, `.cursor/mcp.json`) override user-scoped ones — if both exist and one is broken, that's the source of failure.
- Check the host's MCP log file (varies by client) for the actual error.

### Still stuck?

Email <support@spendexai.com> with the host name, your OS, and a copy of the relevant log output. We usually reply within a few hours.
