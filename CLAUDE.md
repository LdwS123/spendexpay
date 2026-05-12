# Spendex Pay — Engineering Reference

## What this is

**Spendex Pay is the agent that lives in your agents.** It's an MCP server installed once into Claude Code, Cursor, ChatGPT, OpenClaw, Cowork, or any MCP-compatible agent. Once installed, Spendex provides two things to the host agent:

1. **Identity** — the ability to sign up for new services (Vercel, OpenAI, Modal, GitHub Pro, Cursor Pro, etc.) on the user's behalf, with explicit consent.
2. **Wallet** — a Stripe Issuing virtual card that pays for those services, enforced by spending rules in real-time.

**The user has ONE relationship: with Spendex. Spendex has all the relationships with services.** The user never logs in to vercel.com, openai.com, modal.com directly. They configure rules once on Spendex, and their agents handle everything downstream.

**Pitch**: "The agent that lives in your agents. Install Spendex once. Your AI agents can sign up and pay for any service they need. You manage one relationship. We manage the rest."

### Three-phase expansion

- **Now (devs)**: Claude Code / Cursor / Codex users. Connected services: Vercel, OpenAI, Anthropic, Modal, GitHub, Cloudflare.
- **Phase 2 (12mo)**: Consumer agents. Connected services: Netflix, Spotify, Uber, Airbnb, Amazon.
- **Phase 3 (24mo)**: Agents themselves are customers. Companies issue Spendex accounts to their customer-support agents with budget caps.

### The 4 technical bricks

1. **Identity broker** — OAuth flows, account creation via Computer Use, password vault (AES-256-GCM), email aliases (`signup-<hash>@mail.spendexai.com`), verification email inbound webhook.
2. **Payment router** — Stripe Issuing virtual card + rules engine + real-time authorization webhook (<2s decision).
3. **MCP server** — universal tools any agent can call: `pay_for_service`, `signup_to_service`, `request_user_consent`, `check_balance`, `check_spending_rules`, `get_verification_email`, `complete_signup`.
4. **Dashboard** — unified view of connected services, spending, rules, consent history.

### Consent UX — non-negotiable rule

**Consent happens INLINE in the agent's chat**, not via external channels by default. When Spendex needs the user's input (signup confirmation, charge above threshold, new service), the MCP tool returns a structured prompt that the host agent relays to the user in the same conversation. The user replies in the same chat. Spendex proceeds.

Email and Telegram channels exist as **opt-in fallbacks** for async mode (background tasks, overnight runs), not the default flow.

### Legacy tools (deprecated)

The early `deploy_to_vercel`, `subscribe_to_service`, `add_service_credits`, `deploy_to_railway`, `deploy_to_flyio`, `deploy_to_render`, `deploy_to_netlify`, `deploy_to_cloudflare`, `run_modal`, `run_on_replicate`, `run_huggingface_inference`, `generate_gamma`, `provision_supabase_project` tools remain in the repo as **fallbacks** for services that don't have their own native MCP. The primary surface is now `pay_for_service` (universal) + `signup_to_service` (universal). When building new features, use these and not the per-service tools.

---

## Repository layout

```
/
├── src/                        # MCP server (Node.js 20+, TypeScript)
│   ├── index.ts                # Entry point: creates McpServer, registers tools
│   ├── config.ts               # Env var validation, DEV_MODE flag
│   ├── lib/
│   │   ├── db.ts               # Supabase client (lazy singleton via Proxy)
│   │   ├── rate-limit.ts       # In-memory token bucket
│   │   ├── vercel.ts           # Vercel API wrapper (POST /v13/deployments)
│   │   ├── webhooks/           # Webhook stubs (Stripe done; PayPal/Coinbase/Circle TODOs)
│   │   └── payments/
│   │       ├── types.ts        # Branded provider IDs, ChargeResult union
│   │       ├── router.ts       # routePayment() dispatches to correct provider
│   │       ├── stripe.ts
│   │       ├── ach.ts
│   │       ├── paypal.ts
│   │       ├── coinbase.ts
│   │       ├── usdc-base.ts
│   │       ├── apple-pay.ts
│   │       └── google-pay.ts
│   ├── tools/
│   │   └── deploy-vercel.ts    # The only live MCP tool
│   └── tests/                  # Vitest unit tests
├── dashboard/                  # Next.js 15 App Router (separate app, own package.json)
│   ├── app/
│   │   ├── dashboard/          # Overview, transactions, payments, tokens, rules, settings
│   │   ├── pay/[intentId]/     # Approval page for async providers (Apple/Google Pay)
│   │   ├── pay/complete/       # Post-payment confirmation
│   │   └── api/webhooks/stripe # Stripe webhook handler
│   └── ...
└── .mcp.json                   # Registers server with Claude Code (project-level MCP config)
```

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+, TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` (official Anthropic SDK) |
| Transport | stdio — Claude Code spawns the process, communicates over stdin/stdout |
| Database | Supabase (Postgres) |
| Payments | Stripe PaymentIntents + Stripe Issuing for virtual cards |
| Dashboard | Next.js 15 App Router, Tailwind CSS |
| Tests | Vitest |

Dashboard colors: `#070d18` (navy background), `#00e5b4` (teal/mint accent).

---

## Getting started

### MCP server

```bash
cd /Users/kokabuildsf/Spendexpay
cp .env.example .env        # fill in real or dev values
npm install
npm run dev                  # tsx watch, hot reload
# or
npm run build && npm start   # compiled output from dist/
```

### Dashboard

```bash
cd /Users/kokabuildsf/Spendexpay/dashboard
npm install
npm run dev                  # → http://localhost:3000/dashboard
```

Both apps read from `.env`. Set `SPENDEX_DEV=true` for local development without real Stripe or Supabase credentials (all tools return simulated responses).

---

## Testing

Three levels, all important:

### 1. Dev mode (fastest)

Set `SPENDEX_DEV=true` in your environment. Every tool call returns a simulated success. No real Stripe charges, no real Supabase writes. Use this when iterating on tool schemas or response shapes.

### 2. Raw protocol test (no Claude Code required)

Build first, then pipe JSON-RPC directly to the server:

```bash
npm run build

# List available tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | SPENDEX_DEV=true node dist/index.js 2>/dev/null

# Call deploy_to_vercel
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"deploy_to_vercel","arguments":{"project_name":"my-app","mcp_token":"test"}}}' \
  | SPENDEX_DEV=true node dist/index.js 2>/dev/null
```

`2>/dev/null` suppresses debug output (which goes to stderr — see logging rules below).

### 3. Unit tests

```bash
npm test    # vitest, files under src/tests/
```

### 4. Claude Code integration (end-to-end)

`.mcp.json` at the repo root registers the server with Claude Code. After running `npm run build`:

1. Restart Claude Code (it re-reads `.mcp.json` on startup)
2. In a Claude Code session: *"Deploy my-app to Vercel"*
3. Claude Code calls `deploy_to_vercel` via the registered server

---

## Key design decisions

### Branded provider IDs (`src/lib/payments/types.ts`)

Stripe customer IDs, PayPal payer IDs, etc. are nominal types (`StripeCustomerId`, `PayPalPayerId`, ...). Passing the wrong ID type to the wrong provider is a compile-time error, not a runtime mystery. `ChargeResult` is a discriminated union — handlers must exhaustively cover success and every failure mode.

### Lazy Supabase singleton via Proxy (`src/lib/db.ts`)

The Supabase client validates its URL at construction time. In dev mode (`SPENDEX_DEV=true`) there is no real Supabase URL, so constructing the client at module load would crash the server before it could serve a single request. The Proxy defers construction until the first actual DB call, which never happens in dev mode.

### Rate limit runs before authentication (`src/lib/rate-limit.ts`)

The token bucket (10 req/min, 50 req/hr per MCP token) is checked before we touch the database. This prevents two things: timing-based token probing (an attacker can't infer whether a token exists by watching latency), and DB hammering from runaway agents. Limits are tracked in memory; they reset on server restart.

### stdout is sacred — use console.error for debug output

The MCP stdio transport uses stdin/stdout as the JSON-RPC channel. Any stray byte on stdout corrupts the protocol framing. All debug logging, errors, and diagnostics go to `console.error` (stderr). This is non-negotiable.

### Idempotency key format

```
{userId}-{service}-{projectName}-{Date.now()}
```

The millisecond timestamp is deliberate. Stripe's idempotency cache holds a result for 24 hours. If a PaymentIntent fails (network timeout, card decline), reusing the same key returns the cached failure rather than retrying. The timestamp ensures each retry attempt gets a fresh key, so Stripe actually re-runs the charge.

### Emergency stop (`EMERGENCY_STOP` env var)

`config.ts` exposes `emergencyStop` as a getter, not a cached value. This means it re-reads `process.env.EMERGENCY_STOP` on every call. Set it to `"true"` in your process environment and all payment processing stops immediately — no restart required. Useful when investigating a billing anomaly in production.

### Audit log failure is fatal (`deploy_failed_after_payment`)

If a payment succeeds but the subsequent DB audit log write fails, the tool throws rather than returning a success response. The user must know that their charge is unrecorded in our system, even if Stripe has it. Silently swallowing a DB write failure here would make dispute resolution impossible.

---

## Non-negotiable rules

- **Never log Stripe secret keys or MCP tokens** — not to stdout, not to stderr, not to Sentry, not anywhere
- **Always use idempotency keys on PaymentIntents** — see format above
- **Always check `EMERGENCY_STOP`** before processing any payment — it's a getter, don't cache it
- **Never auto-charge above the user's `max_amount`** — surface an error and stop; do not prompt the user inline (that defeats the point of async payments)
- **Audit log every transaction** — MCP call, PaymentIntent result, Stripe webhook — required for dispute resolution
- **console.error only for debug output** — stdout belongs to the MCP protocol

---

## Adding a new service tool

After `deploy_to_vercel` is solid and battle-tested:

1. Create `src/tools/{service-name}.ts` following the structure of `src/tools/deploy-vercel.ts`
2. Add the service wrapper in `src/lib/{service-name}.ts` (like `src/lib/vercel.ts`)
3. Register the tool in `src/index.ts`
4. Add all required env vars to `.env.example` with comments
5. Test in dev mode, then with Stripe test keys, then live

Services on the roadmap: Modal GPU, Fly.io, Railway, Render.

---

## Environment variables

See `.env.example` for the full list with descriptions. The key groups:

- `SPENDEX_DEV` — set to `"true"` to bypass all real services
- `EMERGENCY_STOP` — set to `"true"` to halt all payment processing immediately
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — backend DB access
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — payment processing
- `VERCEL_TOKEN` — used to make actual deployments on behalf of users
- `MCP_TOKEN_SALT` — for hashing MCP tokens before storing in DB

Never commit `.env`. It is in `.gitignore`.

---

## TODOs — not built yet

These are known gaps, not forgotten items:

| Item | Status |
|---|---|
| Supabase schema migration SQL | Not written. The schema exists in code (column names, table names) but no `.sql` migration file has been created or run. You need to create this before the server can use a real DB. |
| Dashboard authentication | All UI is currently mock/static. There is no real auth protecting `/dashboard` routes. |
| `npx @spendexpay/mcp` package | The server is not yet published to npm. Users currently have to clone the repo. |
| Webhook handlers for PayPal, Circle, Coinbase | Stubs exist in `src/lib/webhooks/` but are not implemented. Only the Stripe webhook (`dashboard/app/api/webhooks/stripe`) is real. |
| Modal GPU, Fly.io, and other service tools | Only `deploy_to_vercel` exists. All other services are roadmap. |
| Rate limit persistence | The token bucket is in-memory. Server restarts reset all rate limit counters. This is fine for now but will need a Redis or DB-backed store before multi-process deployment. |

---

## Recent changes

The vision and codebase shifted meaningfully in the last cycle. If you're picking this up fresh, read this section first — it explains why some older docs (and older parts of this file) talk about the project differently.

### The pitch pivot — wallet → identity + wallet

Spendex started as "a wallet your agent can spend from." It is now "**the agent that lives in your agents**" — a unified identity broker *and* wallet. The user has **one** relationship: with Spendex. Spendex has all the relationships with downstream services (Vercel, OpenAI, Modal, GitHub, Netflix tomorrow, Amazon eventually).

That pivot drove three concrete code changes:

1. **Universal `pay_for_service` and `signup_to_service` replaced the per-merchant tool surface.** The legacy `deploy_to_*` and `run_*` tools still work, but they're flagged as fallback. Build new things on the universal surface.
2. **The identity broker is now a first-class brick.** `signup_to_service`, `get_verification_email`, and `complete_signup` together let an agent create accounts on behalf of the user — with explicit consent, AES-256-GCM-encrypted credentials, and an alias inbox at `signup-<hash>@mail.spendexai.com`.
3. **Consent moved inline.** `request_user_consent` returns both a markdown prompt and an MCP Apps SDK widget. Hosts that support the Apps surface render an inline Approve / Decline dialog; hosts that don't get a markdown fallback. The hybrid pattern is non-negotiable — do not break it.

### Database — 6 migrations shipped

The migrations under `supabase/migrations/` (and `supabase/migration.sql` for the consolidated bundle) cover:

| Migration | Tables / changes |
|---|---|
| 001 — initial schema | `users`, `mcp_tokens`, `payment_intents`, `audit_log` |
| 002 — RLS policies | Row-level security on every user-owned table |
| 003 — Stripe Issuing | `stripe_customers`, `issuing_cards`, `issuing_authorizations` |
| 004 — Identity broker | `managed_accounts` (encrypted creds), `email_aliases`, `verification_emails` |
| 005 — Consent | `consent_requests`, `consent_decisions`, `consent_preferences` |
| 006 — Rules and trust | `spending_rules`, `service_trust`, `mcc_policy` |

Apply with `supabase db push` or the consolidated `supabase/migration.sql`.

### Test count

322 Vitest tests, all green on Node 20. The `npm test` line is the source of truth — if you see a different number elsewhere, it's stale.

---

## Where things live

When you need to make a change, the answer to "which folder?" is usually one of these:

| Type of change | Where | Example file |
|---|---|---|
| New MCP tool | `src/tools/{name}.ts` | `src/tools/pay-for-service.ts` |
| Register a tool with the server | `src/lib/register-all-tools.ts` | (single registry — stdio and HTTP share it) |
| New payment provider adapter | `src/lib/payments/{provider}.ts` | `src/lib/payments/stripe.ts` |
| Payment dispatch logic | `src/lib/payments/router.ts` | `routePayment()` |
| New webhook (incoming) | `src/lib/webhooks/{provider}.ts` | `src/lib/webhooks/stripe.ts` |
| Dashboard page | `dashboard/src/app/dashboard/{route}/page.tsx` | `dashboard/src/app/dashboard/transactions/page.tsx` |
| Dashboard API route | `dashboard/src/app/api/{route}/route.ts` | `dashboard/src/app/api/webhooks/stripe/route.ts` |
| DB schema change | `supabase/migrations/{NNN_name}.sql` | `006_rules_and_trust.sql` |
| Consent widget UI | `src/lib/consent/widget.ts` + dashboard `/dashboard/consents` | (hybrid: server returns MCP App resource, dashboard mirrors it) |
| New env var | `.env.example` (with comment) + `src/config.ts` (validation) | |
| Tests | `src/tests/{matching-file}.test.ts` | `src/tests/payment-router.test.ts` |
| CI workflow | `.github/workflows/{name}.yml` | `.github/workflows/deploy-fly.yml` |

---

## Do NOT do

Things that look like reasonable improvements but will silently break Spendex. Future Claudes: read this list before touching anything load-bearing.

- **Do NOT re-implement the legacy `deploy_to_*` / `run_*` tools.** They are deliberately frozen. Anything new goes through `pay_for_service` and `signup_to_service`. Adding a new sibling to the legacy section creates a parallel API surface that drifts from the universal one.
- **Do NOT break the `_meta.ui` hybrid widget pattern in consent tools.** `request_user_consent` returns both a structured `_meta.ui` resource (for hosts with the MCP Apps SDK) and a markdown prompt (for hosts without). Removing either breaks half the supported hosts. If you change the schema, change both.
- **Do NOT log secrets anywhere.** Not card numbers, not CVCs, not `STRIPE_SECRET_KEY`, not `SPENDEX_TOKEN`, not raw passwords. Not stdout, not stderr, not Sentry, not analytics. This applies even to "just this once for debugging" — use ephemeral local logs that never leave the machine.
- **Do NOT write to `stdout` from anywhere in the MCP server process.** Stdout is the JSON-RPC channel. A single stray byte corrupts the protocol framing. All debug output goes to `console.error` (stderr). `console.log` is effectively banned in `src/`.
- **Do NOT cache the `EMERGENCY_STOP` value.** It's a getter in `config.ts` for a reason — operators must be able to halt payments by flipping an env var, with no restart. If you cache it, you defeat the kill switch.
- **Do NOT skip the idempotency key timestamp.** The format is `{userId}-{service}-{projectName}-{Date.now()}`. The millisecond timestamp is deliberate — Stripe caches results for 24 hours and a missing timestamp turns every retry into a replay of the original failure.
- **Do NOT auto-charge above the user's `max_amount`.** Surface an error and stop. Do not prompt inline as a workaround — async payments exist precisely because there's no human to prompt.
- **Do NOT silently swallow audit-log write failures after a successful charge.** If Stripe took the money and the DB write failed, the tool must throw. The user has to know their charge is unrecorded — silent failure makes dispute resolution impossible.
- **Do NOT add a new transport without updating `registerAllTools()`.** stdio (`src/index.ts`) and HTTP (`src/http-server.ts`) both call the same registry. If you add a third transport, it goes through the same registry so the tool surface stays in lockstep.
