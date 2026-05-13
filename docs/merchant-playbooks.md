# Merchant Playbooks — universal Computer-Use checkout instructions

Spendex provides Stripe Issuing virtual cards that work everywhere a real Visa
works. But a Computer-Use agent (Claude Code, Operator, Browser Use) still has
to *click through the checkout form* to deliver that card to a merchant. That
clicking is expensive — tokens, time, and failure modes (A/B test buckets,
stale selectors, 2FA prompts) — and re-discovering selectors on every order
turns shopping into a slow, brittle game of DOM whack-a-mole.

The **merchant playbook registry** (`src/lib/merchant-playbooks.ts`) amortizes
that cost across all users. Each curated playbook is a deterministic list of
URLs, selectors, click sequences, and known gotchas for one merchant. The
universal `prepare_checkout` tool looks up the playbook for the requested
merchant, substitutes the user's virtual card + (optionally) managed-account
credentials, and returns a step-by-step text the agent can execute verbatim.

When a merchant isn't curated, the tool falls back to a **generic playbook**
plus an explicit warning so the agent knows it must read the live DOM and
extract selectors itself.

## V1 supported merchants

| `merchant_id`                | Display name            | `supported` | Default `login_strategy` |
| ---------------------------- | ----------------------- | ----------- | ------------------------ |
| `amazon`                     | Amazon.com              | `full`      | `spendex_managed`        |
| `walmart`                    | Walmart.com             | `full`      | `guest_checkout`         |
| `bestbuy`                    | Best Buy                | `full`      | `guest_checkout`         |
| `ebay`                       | eBay                    | `card_only` | `user_existing`          |
| `generic_stripe_checkout`    | Generic Stripe Checkout | `card_only` | `guest_checkout`         |

Anything not in this table resolves to the generic fallback.

## Adding a new merchant

1. Open `src/lib/merchant-playbooks.ts`.
2. Append a new entry to the `MERCHANT_PLAYBOOKS` array. Required fields:
   - `merchant_id` — short, kebab-cased or single-word (e.g. `"target"`).
   - `display_name` — what the user sees in audit logs and playbook headers.
   - `domains` — array of bare hostnames (no `www.`, no protocol). Used for
     URL-based lookup. Subdomains are matched automatically.
   - `supported` —
     - `"full"`: login + payment + confirmation scripted end-to-end.
     - `"card_only"`: agent handles login manually, we script the card form.
     - `"manual"`: instructions are generic, agent explores everything.
   - `login_strategy` — `"spendex_managed"` (Spendex provisioned the account
     via `signup_to_service`), `"user_existing"` (user is already signed in
     on the browser session), or `"guest_checkout"` (no auth at all).
   - `steps` — ordered array of `PlaybookStep`. See structure below.
   - `known_issues` — bullet list of merchant-specific gotchas surfaced at
     the bottom of the rendered playbook.
   - `fallback_instructions` — single-paragraph fallback the agent applies
     when curated selectors miss.
3. Add tests in `src/tests/tools/prepare-checkout.test.ts` that lookup by
   `merchant_id` and by domain.
4. Update the table above in this doc.

No other code change is needed — the tool surface stays the same, MCP clients
don't see any new tools registered, and `register-all-tools.ts` is unchanged.

## `PlaybookStep` structure

```ts
interface PlaybookStep {
  step: number;
  action: "navigate" | "click" | "type" | "select" | "wait" | "verify" | "extract" | "report";
  target_url?: string;     // for action="navigate"
  selector?: string;       // CSS selector
  value?: string;          // value to type/select — supports {placeholders}
  wait_ms?: number;        // for action="wait"
  description: string;     // human-readable instruction (always rendered)
  gotchas?: string[];      // step-specific A/B variants, known issues
  requires_login?: boolean;// step is only rendered if login_strategy === "spendex_managed"
}
```

### Placeholders substituted in `value` / `target_url`

| Placeholder            | Source                                          |
| ---------------------- | ----------------------------------------------- |
| `{product_url}`        | tool input `product_url`                        |
| `{quantity}`           | tool input `quantity` (defaults to 1)           |
| `{variant}`            | first value in `variant_options`                |
| `{card_number}`        | virtual card PAN, grouped as `4242 4242 ...`    |
| `{card_exp_month}`     | virtual card expiry month, zero-padded          |
| `{card_exp_year}`      | virtual card expiry year, 4 digits              |
| `{card_exp_year_short}`| virtual card expiry year, 2 digits              |
| `{card_cvc}`           | virtual card CVC                                |
| `{cardholder}`         | inferred from `user.email` prefix               |
| `{billing_zip}`        | constant `"75001"` (Spendex EU/Paris)           |
| `{email}`              | managed account email_alias (or empty)          |
| `{password}`           | decrypted managed account password (or empty)   |

Any unrecognized `{xxx}` is left in place — write playbooks defensively.

## Selector patterns

Three families of selectors hold up best in practice. Use them in this
priority order:

1. **`data-*` attributes** — usually the most stable. Examples:
   `[data-automation-id="checkout-btn"]` (Walmart),
   `[data-testid="hosted-payment-submit-button"]` (Stripe),
   `[data-track="Guest Checkout"]` (Best Buy).
2. **Stable input `name` attributes** — Stripe Elements, Amazon's
   `addCreditCardNumber`, `cardNumber`/`cardExpiry`/`cardCvc` on most
   modern forms.
3. **IDs** — Amazon's `#ap_email`, `#placeYourOrder1`. Generally stable but
   can drift across A/B buckets; ALWAYS pair an ID selector with a
   `gotchas` note hinting at the text-content fallback.

Avoid (or only use as fallback):

- Class names (`.btn-primary`, `.add-to-cart-button`) — heavily churned.
- Position selectors (`:nth-child`, descendant chains) — break on layout
  refactors.
- Inline-styled selectors (`[style*="display:none"]`) — bandaid for
  inconsistent A/B variants but always brittle.

When you write a curated playbook, accompany every CSS selector in
`fallback_instructions` with a text-based recovery rule (e.g. "find the
button whose visible text contains 'Place order'") so the agent can recover
when the selector misses.

## Security contract

`prepare_checkout` returns live PAN, CVC, and managed-account password bytes
inline in its response text. Those bytes are:

- **Never** written to stderr.
- **Never** included in the audit log description (only merchant + product
  URL go to the audit table).
- Valid for one checkout — the agent must type them into the merchant's
  payment form and discard them.

Any new playbook author must respect this. If you add steps that surface
*additional* secret material, document it explicitly and update the security
block in `prepare-checkout.ts`.

## Why this design

Spendex's V1 thesis is that the wallet is a commodity but the **identity +
checkout fabric** is the moat. Curated playbooks are the visible form of that
moat: every new merchant we ship widens the gap between "Spendex agents can
buy here" and "your raw Computer-Use agent has to re-figure-it-out". The
registry should grow steadily — one merchant per week is a reasonable target
in V1, weighted toward the heads of the long tail (Amazon, Walmart, Best Buy,
Target, eBay, Etsy, Shopify-hosted stores).
