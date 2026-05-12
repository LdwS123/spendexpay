# Installing Spendex Pay in your agent

Detailed setup for every supported MCP host. Each guide takes 1–2 minutes.

You will need a `SPENDEX_TOKEN` (format: `spx_...`) from <https://spendexai.com/dashboard/settings>. Issue one token per device or per agent so you can rotate them independently.

**Two transports, one product:**

- **Local (stdio):** the wallet runs on the user's machine as an `npx` subprocess. Used by desktop / CLI agents (Claude Code, Cursor, Claude Desktop). Lowest latency, no network round-trip for the JSON-RPC.
- **Remote (Streamable HTTP):** the wallet is hosted at `https://spendex-mcp.fly.dev/mcp`. Used by web-based agents (claude.ai, ChatGPT custom GPTs, Cowork). No install on the user's machine.

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

Claude Code re-reads its MCP config on startup. Ask "list my Spendex tools" to verify.

```
┌──────────────────────────────────────────────────────┐
│  Claude Code v… connected MCP servers: spendex ✓     │
│                                                      │
│  Tools available:                                    │
│    pay_for_service                                   │
│    signup_to_service                                 │
│    request_user_consent                              │
│    submit_consent_decision                           │
│    ... (23 total)                                    │
└──────────────────────────────────────────────────────┘
```

---

## 2. Cursor

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

You should see `spendex` appear with a green dot in Settings → MCP.

---

## 3. Claude Desktop

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

You should see a small hammer icon in the lower right of the chat input — clicking it shows the wallet tools.

---

## 4. claude.ai (web)

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
│  │   23 tools available                           │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

5. Open a new chat. Spendex's tools are available immediately — no restart required.

---

## 5. ChatGPT (custom GPT / Operator)

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

---

## 6. Cowork

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

---

## 7. Verifying the install

In any agent, ask:

> "List my Spendex Pay tools."

You should see 23 tool names returned, starting with `pay_for_service`. If you see them, you're done.

You can also exercise the wallet end-to-end with:

> "Use Spendex to check my balance."

The agent will call `check_balance` and the wallet will reply with the current balance, month-to-date spend, and your monthly budget.

---

## 8. Troubleshooting

### Server fails to start (stdio hosts)

```
[error] spendex: command failed: ENOENT
```

- Run `node --version`. The wallet requires Node 20+.
- Run `npx -y @spendexai/mcp` in your terminal manually. The server should print `Spendex Pay MCP server running on stdio` to stderr. Any other output explains the failure.
- Confirm your JSON config is valid. A trailing comma silently breaks the whole file. Run `node -e "JSON.parse(require('fs').readFileSync('PATH','utf8'))"` to validate.

### Connector unreachable (HTTP hosts)

```
[error] Spendex Pay: handshake timed out
```

- `curl https://spendex-mcp.fly.dev/health` should return `{ "status": "ok" }`. If it doesn't, the service is down — check the status page.
- Make sure the URL ends with `/mcp` exactly. Some hosts auto-append paths and break the route.
- Verify the bearer token is correct. Tokens are scoped per-issuance — the one you generated last week may have been rotated.

### Authentication errors

```
[error] spendex.check_balance: invalid_token
```

- Tokens start with `spx_` and are 48+ characters. If yours is shorter, it was truncated when copied.
- Issue a fresh token from <https://spendexai.com/dashboard/settings> and update the agent config.
- The dashboard hashes tokens with the same `MCP_TOKEN_SALT` as the MCP server. If you've self-hosted the wallet, those two values must match.

### Tools don't appear after restart

- Make sure you fully quit the host (Claude Desktop: Cmd+Q, not the red close button).
- For Cursor, the command palette **MCP: Restart Servers** is more reliable than restarting the whole app.
- Check the host's MCP log file (varies by client) for the actual error.

### Still stuck?

Email <support@spendexai.com> with the host name, your OS, and a copy of the relevant log output. We usually reply within a few hours.
