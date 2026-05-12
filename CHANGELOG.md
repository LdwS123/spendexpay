# Changelog

All notable changes to Spendex Pay are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-05-12

First public release. Spendex Pay ships as `@spendexai/mcp` on npm (stdio
transport for local agents) and as a Streamable HTTP service deployed to
Fly.io at `https://spendex-mcp.fly.dev/mcp` for web-based agents.

**Highlights**

- 24 MCP tools across primary, introspection, and legacy fallback layers
- 322 tests passing on Node 20
- 6 Supabase migrations covering identity, wallet, consent, audit, and RLS
- 13 dashboard pages for spend, rules, consent, services, and tokens
- Stripe Issuing virtual cards with rule enforcement at the card level
- MCP Apps SDK consent widget rendered inline in the host's chat

### Added

#### MCP tools — primary surface (7)

The universal tools every host should reach for first.

- `pay_for_service` — universal payment. Picks native API mode for top services (Vercel, Modal, Anthropic) and falls back to virtual-card reveal for the rest.
- `signup_to_service` — creates the account at the downstream service under the user's identity, stores credentials in the wallet.
- `request_user_consent` — returns a markdown prompt plus a hybrid MCP App widget so the host renders an inline approval dialog.
- `submit_consent_decision` — submits the user's reply (A / B / C / D) to unlock the pending action.
- `check_consent_status` — polls a pending consent request from the agent loop.
- `get_verification_email` — reads the most recent verification email from the wallet's alias inbox (`signup-<hash>@mail.spendexai.com`).
- `complete_signup` — finalizes a signup once the verification link has been confirmed.

#### MCP tools — introspection (3)

State queries an agent runs before committing to a charge.

- `check_balance` — wallet balance plus month-to-date spend plus monthly budget.
- `check_spending_rules` — current rules (consent mode, per-tx cap, monthly budget, trusted services).
- `list_supported_services` — services with native API integration.

#### MCP tools — legacy fallback (14)

Per-merchant tools kept for backwards compatibility. Prefer `pay_for_service` for new integrations.

- `deploy_to_vercel`, `deploy_to_railway`, `deploy_to_flyio`, `deploy_to_render`, `deploy_to_netlify`, `deploy_to_cloudflare`
- `run_modal`, `run_on_replicate`, `run_huggingface_inference`
- `subscribe_to_service`, `add_service_credits`
- `generate_gamma_presentation`, `provision_supabase_project`
- `fetch_product_preview` — Open Graph / metadata preview used by the consent widget

#### Payments

- **Stripe Issuing wallet.** Per-user virtual cards minted on first wallet provisioning. EUR is the default issuing currency (`STRIPE_CARD_CURRENCY`); USD, GBP, CAD, and AUD also supported.
- **Real-time authorization webhook.** `issuing_authorization.request` events are answered in under 2 seconds against the user's spending rules. Approvals and declines are persisted to the audit log.
- **Card-level rule enforcement.** Per-transaction cap, monthly budget, and MCC allowlist all live in Stripe — application-layer bypass is impossible.
- **Emergency stop.** Setting `EMERGENCY_STOP=true` halts all payment processing immediately; the flag is re-read on every authorization (not cached) so no restart is required.
- **Idempotency keys.** All PaymentIntent creation uses `{userId}-{service}-{projectName}-{timestamp}` so retries get fresh keys and don't replay Stripe's 24-hour cached failures.
- **Multi-provider payment router.** Stripe, ACH, PayPal, Coinbase, USDC-on-Base, Apple Pay, Google Pay — all dispatched through the same `routePayment()` entry point with branded provider IDs to prevent cross-provider mistakes at compile time.

#### Identity broker — auto-signup

- **Account creation via Computer Use** for services without OAuth.
- **Password vault** encrypted with AES-256-GCM, keyed off `MANAGED_ACCOUNT_ENCRYPTION_KEY`.
- **Email alias inbox** at `signup-<hash>@mail.spendexai.com`, routed via Resend inbound webhook.
- **Verification email retrieval** through `get_verification_email`, returning the most recent link so the agent can complete confirmation flows autonomously.

#### Consent UX — MCP Apps SDK widget

- **Hybrid widget + markdown.** The host receives both a structured MCP App resource (rendered as a Spendex-branded dialog with Approve / Decline buttons) and a markdown prompt fallback for hosts that don't support the Apps surface.
- **Inline-only by default.** No external channel required. Email and Telegram channels exist as opt-in fallbacks for async mode (background tasks, overnight runs).
- **Four-decision model.** A — approve once. B — approve and remember. C — auto-approve under a cap. D — decline.
- **Product preview cards.** `fetch_product_preview` hydrates the consent widget with the merchant's logo, title, and price so the user sees what they're approving.

#### Transports

- **stdio.** `@spendexai/mcp` on npm. Hosts spawn the process; communication over stdin/stdout. Lowest latency, runs entirely on the user's machine.
- **Streamable HTTP.** `dist/http-server.js` listens on port 3001. Deployed to Fly.io as `spendex-mcp`. Used by claude.ai, ChatGPT custom GPTs, and any other web-based host.
- **Single tool registry.** Both transports call `registerAllTools()` from `src/lib/register-all-tools.ts` so stdio and HTTP always expose the exact same 24 tools in the same order.

#### Dashboard — real-time spend view (13 pages)

- Next.js 15 App Router app under `dashboard/`.
- Pages: home, login, docs, status, dashboard overview, transactions (list + detail), payments, consents (list + detail + preferences), accounts (list + detail), orders, rules, services, settings, tokens.
- Approval flow page at `/pay/[intentId]` for async providers (Apple Pay, Google Pay) plus `/pay/complete` confirmation.
- Legal: `/legal/privacy`, `/legal/terms`, `/legal/refunds`.
- Stripe webhook handler at `/api/webhooks/stripe`.
- Theme: `#070d18` navy background, `#00e5b4` teal accent.

### Security

- **MCP token hashing.** Tokens hashed with HMAC-SHA256 plus `MCP_TOKEN_SALT` before storage. The raw token never sits in the database.
- **AES-256-GCM at rest.** Managed-account passwords stored encrypted; the encryption key is rotated independently of the DB connection string.
- **`stdout` reserved for MCP protocol.** All debug, error, and diagnostic output goes to `stderr`. Card numbers, CVCs, secret keys, and MCP tokens are never logged anywhere.
- **Rate limit before authentication.** The token bucket (10 req/min, 50 req/hr) is checked before any DB lookup, preventing timing-based token probing.
- **MCC blocklist.** The Issuing card is restricted to dev-tools and cloud merchant categories. Charges from other categories (gambling, retail, etc.) are declined automatically by Stripe.
- **Audit log integrity.** If a payment succeeds but the audit log write fails, the tool throws rather than returning success — the user must know that their charge is unrecorded.

### Infrastructure

- **6 Supabase migrations** covering: identity (`users`, `managed_accounts`), wallet (`stripe_customers`, `issuing_cards`), rules (`spending_rules`, `service_trust`), consent (`consent_requests`, `consent_decisions`), audit (`audit_log`, `payment_intents`), and row-level security policies for every table.
- **Lazy Supabase singleton via Proxy.** Defers client construction until the first real DB call, so `SPENDEX_DEV=true` mode doesn't need real DB credentials.
- **322 tests** on Vitest, all green on Node 20. Coverage: payment router, every provider adapter, consent flow, rate limiter, idempotency, audit log, HTTP transport integration, CORS preflight, and tool-registration parity between stdio and HTTP.
- **CI/CD via GitHub Actions.** `test.yml` on every push and PR. `publish-npm.yml` on `v*` tags. `deploy-fly.yml` on server changes. `deploy-vercel.yml` on dashboard changes.

### Known gaps (on the roadmap)

- Native API integrations for Vercel and Modal — currently fallback to card reveal.
- Webhook handlers for PayPal, Circle, and Coinbase exist as stubs but are not yet wired into the dashboard.
- Rate limiter is in-memory; multi-process deployments will need a Redis or DB-backed store.
- Dashboard authentication is currently mock — production deployment must add real session auth before going live.
