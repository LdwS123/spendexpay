# Changelog

All notable changes to Spendex Pay are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-05-12

First public release. Spendex Pay ships as `@spendexai/mcp` on npm (stdio
transport for local agents) and as a Streamable HTTP service deployed to
Fly.io at `https://spendex-mcp.fly.dev/mcp` for web-based agents.

### Added — 23 MCP tools

**Primary surface (7)** — the universal tools every host should reach for first.

- `pay_for_service` — universal payment. Picks native API mode for top services (Vercel, Modal, Anthropic) and falls back to virtual-card reveal for the rest.
- `signup_to_service` — creates the account at the downstream service under the user's identity, stores credentials in the wallet.
- `request_user_consent` — returns a markdown prompt + a hybrid MCP App widget so the host renders inline approval.
- `submit_consent_decision` — submits the user's reply (A / B / C / D) to unlock the pending action.
- `check_consent_status` — poll a pending consent request from the agent loop.
- `get_verification_email` — reads the most recent verification email from the wallet's alias inbox (`signup-<hash>@mail.spendexai.com`).
- `complete_signup` — finalizes a signup once the verification link has been confirmed.

**Introspection (3)** — state queries an agent runs before committing to a charge.

- `check_balance` — wallet balance + month-to-date spend + monthly budget.
- `check_spending_rules` — current rules (consent mode, per-tx cap, monthly budget, trusted services).
- `list_supported_services` — services with native API integration.

**Legacy fallback (13)** — per-merchant tools kept for backwards compatibility. Prefer `pay_for_service` for new integrations.

- `deploy_to_vercel`
- `deploy_to_railway`
- `deploy_to_flyio`
- `deploy_to_render`
- `deploy_to_netlify`
- `deploy_to_cloudflare`
- `run_modal`
- `run_on_replicate`
- `run_huggingface_inference`
- `subscribe_to_service`
- `add_service_credits`
- `generate_gamma_presentation`
- `provision_supabase_project`

### Added — Payments

- **Stripe Issuing integration.** Per-user virtual cards minted on first wallet provisioning. EUR is the default issuing currency (`STRIPE_CARD_CURRENCY`).
- **Real-time authorization webhook.** `issuing_authorization.request` events are answered in under 2 seconds against the user's spending rules. Approvals and declines are persisted to the audit log.
- **Spending-rule enforcement at the card level.** Per-transaction cap, monthly budget, and MCC allowlist all live in Stripe — application-layer bypass is impossible.
- **Emergency stop.** Setting `EMERGENCY_STOP=true` halts all payment processing immediately; the flag is re-read on every authorization (not cached) so no restart is required.
- **Idempotency keys.** All PaymentIntent creation uses `{userId}-{service}-{projectName}-{timestamp}` so retries get fresh keys and don't replay Stripe's 24-hour cached failures.

### Added — Identity broker

- **Account creation via Computer Use** for services without OAuth.
- **Password vault** encrypted with AES-256-GCM, keyed off `MANAGED_ACCOUNT_ENCRYPTION_KEY`.
- **Email alias inbox** at `signup-<hash>@mail.spendexai.com`, routed via Resend inbound webhook.
- **Token security.** MCP tokens hashed with HMAC-SHA256 + `MCP_TOKEN_SALT` before storage. The raw token never sits in the database.

### Added — Consent UX

- **Hybrid widget + markdown.** The host receives both a structured MCP App resource (rendered as a Spendex-branded dialog with Approve / Decline buttons) and a markdown prompt fallback for hosts that don't support the Apps surface.
- **Inline-only by default.** No external channel required. Email and Telegram channels exist as opt-in fallbacks for async mode (background tasks, overnight runs).
- **Four-decision model.** A — approve once. B — approve + remember. C — auto-approve under a cap. D — decline.

### Added — Transports

- **stdio.** `@spendexai/mcp` on npm. Hosts spawn the process; communication over stdin/stdout. Lowest latency, runs entirely on the user's machine.
- **Streamable HTTP.** `dist/http-server.js` listens on port 3001. Deployed to Fly.io as `spendex-mcp`. Used by claude.ai, ChatGPT custom GPTs, and any other web-based host.
- **Single tool registry.** Both transports call `registerAllTools()` from `src/lib/register-all-tools.ts` so stdio and HTTP always expose the exact same 23 tools in the same order.

### Added — Dashboard

- Next.js 15 App Router app under `dashboard/`.
- Routes: overview, transactions, payments, tokens, rules, settings, services, docs.
- Approval flow page at `/pay/[intentId]` for async providers (Apple Pay, Google Pay).
- Stripe webhook handler at `/api/webhooks/stripe`.
- Theme: `#070d18` navy background, `#00e5b4` teal accent.

### Added — Tests

- **309 tests passing**, all green on Node 20.
- Unit coverage for: payment router, Stripe / ACH / PayPal / Coinbase / USDC-Base / Apple Pay / Google Pay adapters, consent flow, rate limiter, idempotency, audit log.
- HTTP transport integration tests for `/mcp`, `/health`, CORS preflight, and tool registration parity with stdio.

### Known gaps (not in 0.1.0, on the roadmap)

- Native API integrations for Vercel and Modal — currently fallback to card reveal.
- Webhook handlers for PayPal, Circle, and Coinbase exist as stubs but are not yet wired into the dashboard.
- Rate limiter is in-memory; multi-process deployments will need a Redis or DB-backed store.
- Dashboard authentication is currently mock — production deployment must add real session auth before going live.
