# Spendex Pay — Product Backlog

Complete catalog of use cases Spendex must handle. Structured as a versioned spec so it can serve as:
- Backlog in Linear/Notion
- Release checklist per version
- Spec for subagents implementing features
- Roadmap section in the VC pitch deck

**Status legend** : ✅ Shipped V1 · 🟡 Partial / needs polish · 🔲 V2 · 🔮 V3+

---

## V1 priorities (what's in scope today)

Per the source spec, V1 ships **Categories 1, 3, 6, 7** (detection, payment, consent, audit).
V2 adds **Category 4 (signup automation) and 5 (advanced rules).**
V3+ adds **Category 11 (partnerships) and 12 (agent autonomy).**

| Category | V1 coverage | Notes |
|---|---|---|
| 1. Detection | 6/10 ✅ | Token validation, virtual card, rules, emergency stop, monthly budget — all live |
| 3. Payment | 5/10 ✅ | One-shot, consent-gated, marketplace work. Subscriptions + refunds + FX = V2 |
| 6. Consent | 5/10 ✅ | In-chat + email + expiration. Push + Telegram batch + modify = V2 |
| 7. Audit | 4/10 ✅ | Real-time dashboard + immutable logs work. Export/digest/anomaly = V2 |

---

## Category 1 — Detection (before any action)

| # | Use case | Status | Where |
|---|---|---|---|
| 1.1 | Valid mcp_token | ✅ | `src/lib/db.ts` — HMAC-SHA256 hash lookup |
| 1.2 | Active virtual card | ✅ | `getActiveVirtualCardForUser()` |
| 1.3 | Rules configured (fallback to safe defaults) | ✅ | `user_consent_preferences` defaults `always_ask` |
| 1.4 | Funding source still valid | 🟡 | Stripe Customer exists; no card expiration check yet |
| 1.5 | Emergency stop env var | ✅ | `config.emergencyStop` getter re-reads `process.env` on every call |
| 1.6 | Monthly budget threshold | ✅ | `getMonthlySpendUsd()` sums `audit_logs` for the calendar month |
| 1.7 | Per-service budget | 🔲 | V2 — only global monthly cap today |
| 1.8 | Service already connected | 🔲 | V2 — no `service_connections` table |
| 1.9 | Detect MCPs installed in host agent | 🔮 | V3 — needs MCP-to-MCP introspection protocol |
| 1.10 | OAuth tokens valid + non-expired | 🟡 | Tokens stored; no expiration tracking |

---

## Category 2 — Authentication & MCP connections

| # | Use case | Status |
|---|---|---|
| 2.1 | Detect MCP servers active in agent | 🔮 V3 |
| 2.2 | Google connected | 🔲 V2 |
| 2.3 | GitHub connected | 🔲 V2 |
| 2.4 | Vercel connected | 🔲 V2 (OAuth integration) |
| 2.5 | Anthropic Console connected | 🔲 V2 |
| 2.6 | OpenAI connected | 🔲 V2 |
| 2.7 | AWS/GCP/Azure connected | 🔮 V3 |
| 2.8 | Third-party payment provider | 🟡 (PayPal/USDC providers exist in code, unused) |
| 2.9 | Detect calling agent (User-Agent, agent_id) | 🟡 (audit_logs.agent_id column exists, not populated) |
| 2.10 | Multi-agent per user | 🟡 (single mcp_token per user today; needs per-agent tokens) |

---

## Category 3 — Payment transactions

| # | Use case | Status | Where |
|---|---|---|---|
| 3.1 | One-shot under threshold | ✅ | `pay_for_service` + `auto_below_threshold` |
| 3.2 | One-shot above threshold | ✅ | `pay_for_service` + `request_user_consent` |
| 3.3 | Recurring subscription | 🔲 V2 — no Stripe Subscription wiring |
| 3.4 | Top-up / credits | 🟡 — works via `pay_for_service`, no balance tracking |
| 3.5 | Marketplace purchase | ✅ | Tested with Amazon AirPods scenario |
| 3.6 | Threshold-triggered auto-topup | 🔲 V2 |
| 3.7 | P2P payment | 🔮 V3 |
| 3.8 | Refund / cancellation | 🔲 V2 |
| 3.9 | Multi-currency with FX | 🟡 — UI supports USD/EUR/GBP; no FX rate display |
| 3.10 | Pre-approved merchants whitelist | 🟡 — `trusted_services` field exists in preferences |

---

## Category 4 — Account signup automation (V2 focus)

| # | Use case | Status |
|---|---|---|
| 4.1 | Auto signup with Spendex email alias | 🟡 — `signup_to_service` returns credentials; Computer Use does the form filling |
| 4.2 | Auto signup with user's email | 🔲 V2 |
| 4.3 | Signup via OAuth (Sign in with Google/GitHub) | 🔲 V2 |
| 4.4 | Email verification catch-all | 🟡 — Resend inbound webhook + `inbound_emails` table exist |
| 4.5 | Captcha handling | 🔲 V2 — needs user notification or third-party solver |
| 4.6 | Phone/SMS verification | 🔮 V3 — needs Twilio partner numbers |
| 4.7 | Service rejects signup | 🔲 V2 — graceful fallback to manual |
| 4.8 | Attach existing account via OAuth | 🔲 V2 |

---

## Category 5 — Rules engine (V2 focus)

| # | Use case | Status |
|---|---|---|
| 5.1 | Global rules (max_per_tx, monthly_cap) | ✅ |
| 5.2 | Per-service rules | 🔲 V2 |
| 5.3 | Per-category rules (MCC) | 🟡 — Stripe Issuing card-level MCC blocklist live |
| 5.4 | Time-based rules (business hours) | 🔲 V2 |
| 5.5 | Per-agent rules | 🔲 V2 — needs agent_id propagation |
| 5.6 | Per-project rules | 🔲 V2 |
| 5.7 | Multi-user / team approval | 🔮 V3 |
| 5.8 | Anomaly detection | 🔲 V2 |
| 5.9 | Service-specific spending_controls on the Stripe card | 🟡 — global MCC blocklist set; no per-service refinement |
| 5.10 | Velocity rules (N tx/hour) | 🔲 V2 |

---

## Category 6 — Consent flow

| # | Use case | Status | Where |
|---|---|---|---|
| 6.1 | In-chat consent | ✅ | `request_user_consent` + widget + markdown fallback |
| 6.2 | Push notification | 🔲 V2 — needs web push or mobile app |
| 6.3 | Telegram | 🟡 — bot exists, basic flow, `/start` link wired |
| 6.4 | Email | ✅ | Resend HTML with HMAC one-click links |
| 6.5 | Expiration auto-decline | ✅ | `expires_at` column + server-side check |
| 6.6 | Batch consent | 🔲 V2 |
| 6.7 | Consent revoke | 🔲 V2 |
| 6.8 | Consent with modification | 🔲 V2 |
| 6.9 | Recurring consent (12 months) | 🔲 V2 |
| 6.10 | Emergency override | 🟡 — `EMERGENCY_STOP` env var; no UI yet |

---

## Category 7 — Audit & reporting

| # | Use case | Status | Where |
|---|---|---|---|
| 7.1 | Audit every event | ✅ | `audit_logs` table — immutable append-only |
| 7.2 | Real-time dashboard | ✅ | Supabase Realtime + `TransactionsClient` |
| 7.3 | CSV/PDF export | 🔲 V2 |
| 7.4 | Duplicate detection | 🟡 — idempotency keys; no UI dedup view |
| 7.5 | Reconciliation with funding source | 🔲 V2 |
| 7.6 | Anomaly alerts | 🔲 V2 |
| 7.7 | Weekly digest | 🔲 V2 |
| 7.8 | Forensic audit (microsec timestamps) | ✅ | `created_at` is `timestamptz` |

---

## Category 8 — Security & compliance

| # | Use case | Status |
|---|---|---|
| 8.1 | mcp_token rotation | ✅ — `/api/tokens/rotate` |
| 8.2 | Freeze card on demand | 🟡 — Stripe API supports it; no dashboard button yet |
| 8.3 | Replace card on compromise | 🟡 — same as 8.2 |
| 8.4 | Compliance reporting (SOC 2, GDPR) | 🔲 V2 |
| 8.5 | Data export (GDPR portability) | 🔲 V2 |
| 8.6 | Account deletion (with 7-year retention) | 🟡 — `/api/settings/account` delete; no scheduled retention policy yet |
| 8.7 | 2FA / MFA for critical actions | 🔲 V2 |
| 8.8 | IP whitelisting | 🔮 V3 |
| 8.9 | Webhook signature verification | ✅ | Stripe + Resend + Telegram + Circle all verified |
| 8.10 | Replay attack prevention | ✅ | Idempotency keys + HMAC tokens |

---

## Category 9 — Edge cases & errors

| # | Use case | Status |
|---|---|---|
| 9.1 | Network failure mid-charge | ✅ — idempotency keys |
| 9.2 | Webhook delay | ✅ — async audit log update |
| 9.3 | User cancels mid-flow | 🟡 — consent cancel works; no in-flight charge cancellation |
| 9.4 | Service down | 🟡 — clean error path; no retry queue |
| 9.5 | Card declined by Stripe | ✅ — webhook returns structured decline |
| 9.6 | Token rotated mid-tx | 🟡 — fails on next call; no transparent re-auth |
| 9.7 | User deleted | 🟡 — `set null` cascade in audit_logs |
| 9.8 | Concurrent transactions | 🟡 — race-safe at consent layer; budget check is read-then-act |
| 9.9 | Service charges different amount | 🟡 — Stripe Issuing webhook approves the actual amount, not the requested |
| 9.10 | Partial refund | 🔲 V2 |

---

## Category 10 — Onboarding & lifecycle

| # | Use case | Status |
|---|---|---|
| 10.1 | First-time signup flow | ✅ — Supabase auth + onboarding API + first card provisioning |
| 10.2 | Tier upgrade (free → pro) | 🔲 V2 — no billing tiers yet |
| 10.3 | Tier downgrade | 🔲 V2 |
| 10.4 | Account deletion | 🟡 — DELETE endpoint exists; subscription cancellation not wired |
| 10.5 | Inactivity sleep mode | 🔲 V2 |
| 10.6 | Team invite | 🔮 V3 |
| 10.7 | Team member offboard | 🔮 V3 |

---

## Category 11 — Partnerships & integrations (V3)

| # | Use case | Status |
|---|---|---|
| 11.1 | Service partner API (Vercel/Modal/Cloudflare official) | 🔮 V3 — `native_api` route in `pay_for_service` reserved; registry empty |
| 11.2 | "Pay with Spendex" in merchant checkout | 🔮 V3 |
| 11.3 | Revenue share with services | 🔮 V3 |
| 11.4 | White-label "Powered by Spendex" | 🔮 V3 |

---

## Category 12 — Future (V2 / V3)

| # | Use case | Status |
|---|---|---|
| 12.1 | Agent-to-agent payment (A2A) | 🔮 V3 |
| 12.2 | Agent with delegated budget (no human) | 🔮 V3 |
| 12.3 | Multi-tenant agentic finance | 🔮 V3 |
| 12.4 | Spendex as agent identity broker | 🔮 V3 |
| 12.5 | Insurance product | 🔮 V3 |
| 12.6 | Data marketplace (anonymized) | 🔮 V3 |

---

## V1 coverage summary

**Shipped (✅) — 23 use cases**
- Detection: 1.1, 1.2, 1.3, 1.5, 1.6
- Payment: 3.1, 3.2, 3.5
- Signup: (none fully — 4.1 partial)
- Rules: 5.1
- Consent: 6.1, 6.4, 6.5
- Audit: 7.1, 7.2, 7.8
- Security: 8.1, 8.9, 8.10
- Edge cases: 9.1, 9.2, 9.5
- Onboarding: 10.1

**Partial (🟡) — 23 use cases needing polish**
- Tracked above with `🟡`. Many are "wire exists, UI missing" or "code path exists, untested in prod".

**V2 backlog (🔲) — 41 use cases**

**V3+ (🔮) — 17 use cases**

---

## Action items for V2 (next 2 months)

In priority order:

1. **Per-service spending limits** (5.2) — biggest gap from V1's safety story
2. **Stripe Subscription wiring** (3.3) — needed for "agent subscribes to Vercel Pro monthly"
3. **Vercel OAuth + native API path** (4.3, 11.1) — first partnership proof of concept
4. **CSV export + weekly digest** (7.3, 7.7) — table stakes for any user with > 10 transactions
5. **Push notifications via web push** (6.2) — replaces awkward email-only async consent
6. **Anomaly detection + velocity rules** (5.8, 5.10) — protects against runaway agents

---

*Last updated: 2026-05-12. Tracked against commit `313af20`.*
