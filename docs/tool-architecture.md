# Spendex Pay — MCP Tool Architecture

How Spendex's MCP surface is shaped, what each tool does, and which one your agent should call for any given job.

## TL;DR

Spendex Pay exposes **24 MCP tools** in three layers:

1. **Primary (7)** — universal `pay_for_service` and `signup_to_service`, plus the consent flow and email helpers that support them. Service-agnostic, this is what new integrations should use.
2. **Introspection (3)** — read-only tools an agent uses to check balance, rules, and supported services *before* moving money.
3. **Legacy fallback (14)** — original per-merchant tools (`deploy_to_vercel`, `run_modal`, …). Still functional, still wired into the same payments + audit pipeline, but flagged as legacy in their descriptions so MCP clients can deprioritize them.

Tool registration order in `src/lib/register-all-tools.ts` mirrors this hierarchy, so both stdio and Streamable HTTP transports expose the same 24 tools in the same order.

---

## The map

```
                        ┌──────────────────────────────┐
                        │      Spendex Pay (MCP)       │
                        │      24 tools total          │
                        └──────────────┬───────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        ▼                              ▼                              ▼
┌───────────────┐            ┌───────────────────┐          ┌──────────────────┐
│  Primary (7)  │            │  Introspection (3)│          │  Legacy (14)     │
│  service-     │            │  read-only state  │          │  per-merchant    │
│  agnostic     │            │  queries          │          │  fallback        │
├───────────────┤            ├───────────────────┤          ├──────────────────┤
│ pay_for_      │            │ check_balance     │          │ deploy_to_vercel │
│   service     │            │ check_spending_   │          │ deploy_to_       │
│ signup_to_    │            │   rules           │          │   railway        │
│   service     │            │ list_supported_   │          │ deploy_to_flyio  │
│ request_user_ │            │   services        │          │ deploy_to_render │
│   consent     │            └───────────────────┘          │ deploy_to_       │
│ submit_       │                                           │   netlify        │
│   consent_    │                                           │ deploy_to_       │
│   decision    │                                           │   cloudflare     │
│ check_        │                                           │ run_modal        │
│   consent_    │                                           │ run_on_replicate │
│   status      │                                           │ run_hugging-     │
│ get_          │                                           │   face_inference │
│   verification│                                           │ subscribe_to_    │
│   _email      │                                           │   service        │
│ complete_     │                                           │ add_service_     │
│   signup      │                                           │   credits        │
└───────────────┘                                           │ generate_gamma_  │
                                                            │   presentation   │
                                                            │ provision_       │
                                                            │   supabase_      │
                                                            │   project        │
                                                            │ fetch_product_   │
                                                            │   preview        │
                                                            └──────────────────┘
```

---

## Primary (7) — universal surface

Service-agnostic. They take a merchant identifier (a string like `"vercel"`, `"modal"`, `"openai"`) plus an amount and route the action through one universal flow.

| Tool | One-line description | When to use |
|---|---|---|
| `pay_for_service` | Charge an arbitrary merchant. Authorizes against the user's spending rules, then either calls the merchant's API directly (when supported) or returns virtual-card details for the agent to type into checkout. | Whenever the agent needs to spend money. Replaces every `deploy_to_*`, `run_*`, `subscribe_to_service`, `add_service_credits` call. |
| `signup_to_service` | Create an identity on a merchant the user doesn't yet have an account with. Generates an email alias and (if needed) a virtual card. | When the agent hits "you must sign up first" on a downstream service. |
| `request_user_consent` | Inline gate before a critical action (large charge, recurring subscription, auto-signup). Returns a markdown prompt plus an MCP Apps SDK widget; the host renders an inline Approve / Decline dialog. | Before any action that might exceed the user's saved thresholds, or any first-time interaction with a new service. |
| `submit_consent_decision` | Records the user's choice (A — approve once / B — approve and remember / C — auto-approve under cap / D — decline) back into the consent record. | After the user replies to a `request_user_consent` prompt in the chat. |
| `check_consent_status` | Polls a consent record by ID. | After `TIMEOUT` from `request_user_consent`, to resolve a decision the user made out-of-band (email, dashboard, Telegram). |
| `get_verification_email` | Fetches the most recent verification email delivered to the alias created during signup. | After `signup_to_service` returns "verification required". |
| `complete_signup` | Marks the merchant account as active and stores any credentials returned from the signup flow. | After `get_verification_email` returns a confirm link the agent has acted on. |

### End-to-end example

"Sign me up for Linear and pay for the Standard plan":

```
signup_to_service           (creates alias + virtual card)
  └─▶ get_verification_email   (resolves the confirm link)
       └─▶ complete_signup     (stores credentials)
            └─▶ pay_for_service   (charges the upgrade)
```

`request_user_consent` slots in front of any step that exceeds the user's saved thresholds.

---

## Introspection (3) — agent self-monitoring

Read-only. Agents should consult these *before* `pay_for_service` to self-throttle and avoid wasted work.

| Tool | One-line description | When to use |
|---|---|---|
| `check_balance` | Returns month-to-date spend, monthly budget, and per-transaction cap. | Before any non-trivial charge — confirm the wallet has room. |
| `check_spending_rules` | Lists active rules and can simulate whether a specific charge would be approved or declined. | When the agent is unsure whether a planned action will pass — saves a round-trip through Stripe. |
| `list_supported_services` | Reports which merchants have a first-class API integration vs. card-only support. | At the start of a multi-step task, to plan which merchant to use. |

These never move money. They also never require user consent — they're pure state queries.

---

## Legacy fallback (14) — per-merchant tools

| Group | Tools |
|---|---|
| Deploys | `deploy_to_vercel`, `deploy_to_railway`, `deploy_to_flyio`, `deploy_to_render`, `deploy_to_netlify`, `deploy_to_cloudflare` |
| Compute | `run_modal`, `run_on_replicate`, `run_huggingface_inference` |
| Recurring | `subscribe_to_service`, `add_service_credits` |
| One-off generation | `generate_gamma_presentation` |
| Provisioning | `provision_supabase_project` |
| Consent helper | `fetch_product_preview` |

All still work, all still wired into the same payments + audit log pipeline. Their descriptions are prefixed with `[Legacy fallback — prefer pay_for_service for new integrations]` so MCP clients can deprioritize them.

They exist because:

- Older clients are pinned to specific tool names and rely on them.
- A few merchants have stable, narrow surfaces that benefit from explicit arguments (a Vercel `project_name` vs. a free-form `pay_for_service` call).

Agents that want the simplest possible integration should call `pay_for_service` first. Falling back to `deploy_to_vercel` (etc.) is fine if the universal tool returns "not supported" for some merchant-specific reason — but the legacy path should never be the default.

---

## Tool selection flowchart

```
                       Agent has a goal
                              │
              ┌───────────────┴────────────────┐
              │                                │
       Spend money?                    Just check state?
              │                                │
              ▼                                ▼
    Does user have an              ┌──────────────────────┐
    account at this service?       │ check_balance        │
              │                    │ check_spending_rules │
       ┌──────┴──────┐             │ list_supported_      │
       │             │             │   services           │
      No            Yes            └──────────────────────┘
       │             │
       ▼             ▼
  signup_to_   Does it exceed
   service     the rules?
       │             │
       ▼      ┌──────┴──────┐
  get_         No           Yes
   verification │            │
   _email       │            ▼
       │        │     request_user_consent
       ▼        │            │
  complete_     │            ▼
   signup       │     submit_consent_
       │        │       decision (after
       │        │       user replies)
       │        │            │
       │        │      ┌─────┴─────┐
       │        │   APPROVED    DECLINED
       │        │      │            │
       │        ▼      ▼            ▼
       └──▶ pay_for_service    (stop, surface
                  │              error to user)
                  ▼
            Success ⇒ audit log
            Decline ⇒ audit log + error
```

### Quick decision rules

- **Agent wants to deploy / run / charge anything** → `pay_for_service`.
- **Agent doesn't have an account at the merchant** → `signup_to_service`, then loop through `get_verification_email` and `complete_signup`.
- **Charge exceeds the user's per-tx cap or hits a non-trusted service** → `request_user_consent` first.
- **Consent timed out and we want to know if the user answered out-of-band** → `check_consent_status`.
- **Agent wants to plan without spending** → `check_balance`, `check_spending_rules`, `list_supported_services`.
- **Agent is hand-rolling a one-off Vercel deploy and the universal path won't work** → only then reach for `deploy_to_vercel`. Same for the other legacy tools.

---

## Adding a new service

The fast path:

1. Add the merchant to the dispatch logic inside `pay_for_service` (and `signup_to_service` if signups make sense).
2. If the merchant has a useful native API, add a small wrapper under `src/lib/<merchant>.ts` and call it from the dispatch. Otherwise return `card_reveal` and let Stripe Issuing enforce the limit at checkout.
3. Add the merchant to the list returned by `list_supported_services`.

Do **not**:

- Create a new top-level `deploy_to_<merchant>` or `run_<merchant>` tool. The legacy section is closed to new entries.
- Duplicate the rate-limit / consent / audit-log scaffolding — extend the shared helpers in `src/lib/` instead.

If a merchant truly needs its own tool (rare — usually a regulatory or contractual requirement), document the justification in a comment at the top of the new tool file and register it in the legacy section of `src/lib/register-all-tools.ts` with the `[Legacy fallback —]` prefix so it doesn't pretend to be primary surface.
