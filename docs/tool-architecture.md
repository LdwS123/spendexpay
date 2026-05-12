# Spendex Pay — MCP Tool Architecture

This document describes the surface that Spendex Pay's MCP server exposes to AI
coding agents, why it is split the way it is, and the rules for adding new
capabilities.

## TL;DR

The MCP server is organized into three layers, in this order:

1. **Primary surface** — two universal tools (`pay_for_service`,
   `signup_to_service`) plus the consent flow and email helpers that support
   them.
2. **Introspection** — read-only tools an agent uses to check its own state
   before spending money.
3. **Legacy fallback** — the original per-merchant tools (`deploy_to_vercel`,
   `run_modal`, …). Still functional, but new integrations should never add a
   sibling here.

Tool registration order in `src/index.ts` mirrors this hierarchy. The
descriptions of legacy tools are prefixed with `[Legacy fallback — prefer
pay_for_service for new integrations]` so MCP clients can deprioritize them in
their UI.

---

## Primary surface

These tools are service-agnostic. They take a merchant identifier (a string
like `"vercel"`, `"modal"`, `"openai"`) and an amount, and route the action
through a universal flow.

| Tool | Purpose |
| --- | --- |
| `pay_for_service` | Charge an arbitrary merchant. Authorizes against the user's spending rules, then either calls the merchant's API directly (when supported) or returns virtual card details the agent can type into checkout. Replaces `deploy_to_*`, `run_*`, `subscribe_to_service`, and `add_service_credits`. |
| `signup_to_service` | Create an identity on a merchant the user does not yet have an account with. Generates an email alias and (if needed) a virtual card. |
| `request_user_consent` | Inline gate before a critical action (large charge, recurring subscription, auto-signup). Returns `APPROVED`, `DECLINED`, or `TIMEOUT`. |
| `submit_consent_decision` | The agent records the user's choice back into the consent record. |
| `check_consent_status` | Polls a consent record by ID — used after `TIMEOUT` to resolve a decision the user made out-of-band. |
| `get_verification_email` | Fetches the most recent verification email delivered to the alias created during signup. |
| `complete_signup` | Marks the merchant account as active and stores any credentials returned from the signup flow. |

A typical end-to-end flow for "sign me up for Linear and pay for the Standard
plan" looks like:

```
signup_to_service       (creates alias + virtual card)
  → get_verification_email  (resolves the confirm link)
  → complete_signup     (stores credentials)
  → pay_for_service     (charges the upgrade)
```

`request_user_consent` slots in front of any step that exceeds the user's saved
thresholds.

---

## Introspection

| Tool | Purpose |
| --- | --- |
| `check_balance` | Returns month-to-date spend, monthly budget, and per-transaction cap. |
| `check_spending_rules` | Lists active rules and can simulate whether a specific charge would be approved or declined. |
| `list_supported_services` | Reports which merchants have a first-class integration vs. card-only support. |

These never move money. Agents should consult them *before* `pay_for_service`
to self-throttle and avoid wasted work.

---

## Legacy fallback

| Group | Tools |
| --- | --- |
| Deploys | `deploy_to_vercel`, `deploy_to_railway`, `deploy_to_flyio`, `deploy_to_render`, `deploy_to_netlify`, `deploy_to_cloudflare` |
| Compute | `run_modal`, `run_on_replicate`, `run_huggingface_inference` |
| Recurring | `subscribe_to_service`, `add_service_credits` |
| One-off generation | `generate_gamma_presentation` |
| Provisioning | `provision_supabase_project` |

All of these still work and remain wired into the same payments + audit log
pipeline. Their code is intact — only their descriptions have been updated to
flag them as legacy. They exist because:

- Older clients are pinned to specific tool names and rely on them.
- A few merchants have stable, narrow surfaces that benefit from explicit
  arguments (a Vercel `project_name` vs. a free-form `pay_for_service` call).

Agents that want the simplest possible integration should call
`pay_for_service` first; falling back to `deploy_to_vercel` (etc.) is fine if
the universal tool returns "not supported" for some merchant-specific reason,
but the legacy path should not be the default.

---

## Adding a new service

The fast path:

1. Add the merchant to the dispatch logic inside `pay_for_service` (and
   `signup_to_service` if signups make sense).
2. If the merchant has a useful native API, add a small wrapper under
   `src/lib/<merchant>.ts` and call it from the dispatch. Otherwise return
   `card_reveal` and let Stripe Issuing enforce the limit at checkout.
3. Add the merchant to the list returned by `list_supported_services`.

Do **not**:

- Create a new top-level `deploy_to_<merchant>` or `run_<merchant>` tool. The
  legacy section is closed to new entries.
- Duplicate the rate-limit / consent / audit-log scaffolding — extend the
  shared helpers in `src/lib/` instead.

If a merchant truly needs its own tool (rare — usually a regulatory or
contractual requirement), document the justification in a comment at the top of
the new tool file and register it in the legacy section of `src/index.ts` with
the `[Legacy fallback —]` prefix so it does not pretend to be primary surface.
