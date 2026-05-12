# Get your AI agent paying for stuff in 5 minutes

> From signup to your agent buying its first Vercel upgrade

---

## Minute 1 — Create your Spendex account

- Go to [`https://app.spendexai.com/login`](https://app.spendexai.com/login)
- Enter your email — we send a magic link (no password to remember)
- Click the link, you land on the dashboard

That's it. You now have a Spendex account.

---

## Minute 2 — Connect a funding card

- Click **Funding source** in the sidebar
- A Stripe Elements form opens inline
- Enter your real card — or `4242 4242 4242 4242` if you're testing

```
Card     4242 4242 4242 4242
Expiry   any future date
CVC      any 3 digits
ZIP      any 5 digits
```

This card funds your Spendex wallet. **Your agents never see this card directly** — they only see the virtual card we issue in the next step.

---

## Minute 3 — Provision your virtual wallet

- Click **Wallet** in the sidebar
- Hit **Create virtual card** — Spendex issues a Stripe Issuing card just for your agent
- Default MCC categories: `dev-tools`, `shopping`, `subscriptions`, `travel`
- The card number, expiry, and CVC are shown once — these are what your agent uses to pay

You can rotate this card or block a category anytime from the same page.

---

## Minute 4 — Generate an MCP token

- Click **MCP tokens** in the sidebar
- Click **Generate token**
- A token starting with `spx_...` appears

**Copy it now.** It will not be shown again — we only store the hash. If you lose it, generate a new one and rotate.

This token is how your agent authenticates with Spendex.

---

## Minute 5 — Wire Spendex into Claude Code

Run this in your terminal:

```bash
claude mcp add spendex
```

Or paste this snippet directly into your `.mcp.json`:

```json
{
  "mcpServers": {
    "spendex": {
      "command": "npx",
      "args": ["-y", "@spendexai/mcp"],
      "env": {
        "SPENDEX_TOKEN": "spx_paste_yours_here"
      }
    }
  }
}
```

- Restart Claude Code so it re-reads the MCP config
- In a new chat, type: `Use spendex to check my balance`
- Claude calls `check_balance` and reports your wallet status

You're live.

---

## What your agent can do now

- **"Deploy this app to Vercel"** — agent calls `pay_for_service` for Vercel Pro, hands you the URL.
- **"Top up Modal credits for ML training"** — agent runs `pay_for_service` against Modal.
- **"Buy these headphones on Amazon for $200"** — agent calls `request_user_consent`, shows you a product preview, you click **Approve** in chat, agent completes checkout.

Same MCP server works in Cursor, ChatGPT desktop, OpenClaw, or any MCP-compatible agent. Install once, use everywhere.

---

## Set up consent and rules (optional but recommended)

Configure at `/dashboard/rules`:

- **Per-transaction cap** — e.g. `$50` max per single charge
- **Monthly budget** — e.g. `$500` rolling 30-day window
- **Allowed merchant categories** — toggle MCC groups on/off

Configure at `/dashboard/consents/preferences`:

| Mode | Behavior |
|---|---|
| `always_ask` | Every charge needs your inline approval. **Default. Safest.** |
| `auto_below_threshold` | Auto-approve under your cap, ask above |
| `auto_for_trusted_services` | Auto-approve services on your trust list |

For your first week, leave it on `always_ask`. Get comfortable with what your agent actually does before loosening.

---

## Verify it's all working

- Open `/dashboard/transactions` — every agent action appears here in real time
- Open `/dashboard/consents` — full history of consent prompts and your decisions
- Run the smoke test against the deployed MCP server:

```bash
./scripts/smoke-test-mcp.sh https://spendex-mcp.fly.dev
```

If all three checks pass, you're production-ready.

---

## Next steps

- Read [`DEMO-FLOWS.md`](./DEMO-FLOWS.md) for three end-to-end agent scenarios
- Skim [`tool-architecture.md`](./tool-architecture.md) if you want to know which MCP tools fire when
- Hit `support@spendexai.com` if anything's broken — we read every message
