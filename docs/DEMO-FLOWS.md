# Demo Flows

Three end-to-end scenarios showing exactly what the user types, what the agent does, and what shows up on the dashboard. Use these to test your install, to demo Spendex to teammates, or as a script for a screen recording.

Assumptions:
- You've finished [`QUICKSTART.md`](./QUICKSTART.md)
- Spendex MCP is wired into Claude Code
- Wallet has at least `$100` available
- Consent preference is `always_ask`

---

## Demo 1 — Agent deploys to Vercel and pays for Pro upgrade

**Scenario:** You're shipping a Next.js side project. Free tier is rate-limiting your build. You ask Claude Code to deploy it and upgrade if needed.

### Transcript

**User:**
> Deploy my repo `acme-landing` to Vercel. If the Free plan blocks the build, upgrade to Pro and retry.

**Agent (Claude Code):**
> I'll start the deploy. Calling `spendex.deploy_to_vercel`...
>
> The Free tier build failed: *"Build minutes exceeded for this billing period."* I need to upgrade to Vercel Pro ($20/month) to continue.

**Agent calls** `request_user_consent`:

```
[screenshot: consent-prompt-inline]
─────────────────────────────────────────
  Spendex needs your approval
─────────────────────────────────────────
  Service:    Vercel Pro
  Amount:     $20.00 / month
  Reason:     Build minutes exceeded on Free
  Card:       •••• 4811 (Spendex virtual)
─────────────────────────────────────────
  [ Approve ]   [ Deny ]   [ Always allow Vercel ]
```

**User:** clicks **Approve**

**Agent:**
> Approved. Charging now via `spendex.pay_for_service`...
>
> Paid $20.00 to Vercel. Account upgraded. Redeploying...
>
> Done. Live at `https://acme-landing.vercel.app`.

### Dashboard shows

- **`/dashboard/transactions`** — new row:
  - `Vercel — $20.00 — Pro subscription — Approved by user`
  - [screenshot: transactions-vercel-row]
- **`/dashboard/consents`** — entry:
  - `2026-05-12 14:22 — Vercel Pro upgrade — APPROVED`
  - [screenshot: consents-history]
- **`/dashboard/services`** — Vercel now listed as a connected service with active subscription
  - [screenshot: services-vercel-active]

### What just happened under the hood

1. `deploy_to_vercel` tried the Free plan, returned a structured `upgrade_required` error
2. Agent called `check_spending_rules` — `$20` is under per-tx cap, monthly budget has room
3. Agent called `request_user_consent` — Spendex returned a structured prompt the host agent rendered inline
4. User approved → `submit_consent_decision` → `pay_for_service` ran
5. Stripe PaymentIntent on the virtual card → Stripe webhook → audit log → DB row

---

## Demo 2 — Agent buys headphones on Amazon

**Scenario:** You mentioned in a chat that you need new headphones. Your agent shops, finds a match, and asks before buying.

### Transcript

**User:**
> I need new over-ear headphones for calls, under $250. Buy a good pair on Amazon.

**Agent (Claude Code):**
> Searching Amazon for over-ear call headphones under $250...
>
> Found a strong match. Let me show you before charging.

**Agent calls** `fetch_product_preview`:

```
[screenshot: product-preview-card]
─────────────────────────────────────────
  Sony WH-1000XM5 — Wireless Noise-Cancelling
─────────────────────────────────────────
  $228.00 (Prime, ships tomorrow)
  4.6 stars · 18,400 reviews
  Best-in-class ANC for calls
  [thumbnail]
─────────────────────────────────────────
```

**Agent calls** `request_user_consent` with the preview attached:

```
[screenshot: consent-prompt-with-product]
─────────────────────────────────────────
  Spendex needs your approval
─────────────────────────────────────────
  Merchant:   Amazon
  Item:       Sony WH-1000XM5
  Amount:     $228.00
  Card:       •••• 4811 (Spendex virtual)
  Ship to:    [your saved address]
─────────────────────────────────────────
  [ Approve ]   [ Deny ]   [ Pick a different one ]
```

**User:** clicks **Approve**

**Agent:**
> Approved. Filling Amazon checkout via Computer Use...
>
> Order placed. Confirmation `#114-2298471-1`. ETA tomorrow by 9 PM.

### Dashboard shows

- **`/dashboard/transactions`** — `Amazon — $228.00 — Sony WH-1000XM5 — Approved`
  - [screenshot: transactions-amazon-row]
- **`/dashboard/consents`** — entry with product thumbnail preserved
  - [screenshot: consents-amazon-detail]
- **`/dashboard/orders`** — Amazon order with tracking number once it ships
  - [screenshot: orders-amazon-tracking]

### What just happened under the hood

1. Agent ran `fetch_product_preview` — Spendex scraped a structured preview (price, rating, image, ship date)
2. Agent ran `request_user_consent` — Spendex generated an inline consent prompt with the product card embedded
3. User approved → Spendex authorized the virtual card for exactly `$228.00` to merchant category `shopping`
4. Computer Use session logged into Amazon (Spendex-managed account), filled checkout, submitted
5. Stripe Issuing authorization webhook fired in < 2s with `approved=true`
6. Audit log written, order tracked in `/dashboard/orders`

---

## Demo 3 — Agent signs up to a brand-new service (Modal)

**Scenario:** Your agent needs GPUs for an inference job. You don't have a Modal account yet. Spendex handles the whole signup.

### Transcript

**User:**
> Run this Stable Diffusion fine-tune on Modal. I don't have a Modal account, set one up.

**Agent (Claude Code):**
> No Modal account on file. I'll sign you up. Calling `spendex.signup_to_service`...

**Agent calls** `signup_to_service` with `service: "modal"`:

Spendex executes:
1. Generates a managed email alias: `signup-7a91f@mail.spendexai.com`
2. Generates and stores a strong password in the AES-256-GCM vault
3. Spins up a Computer Use session at `modal.com/signup`
4. Fills email, password, profile fields
5. Waits for the verification email at the inbound webhook
6. Clicks the verification link from inside the Computer Use session
7. On the billing page, enters the Spendex virtual card

```
[screenshot: signup-progress-inline]
─────────────────────────────────────────
  Signing you up to Modal
─────────────────────────────────────────
  [✓] Email alias created
  [✓] Account registered
  [✓] Verification email received
  [✓] Email verified
  [✓] Virtual card added to Modal billing
  [✓] $20 starter credits granted
─────────────────────────────────────────
```

**Agent calls** `request_user_consent` for the first usage charge:

```
[screenshot: consent-modal-first-charge]
─────────────────────────────────────────
  Spendex needs your approval
─────────────────────────────────────────
  Service:    Modal (new account)
  Estimated:  ~$8.40 for 1× A10G · 45 min
  Card:       •••• 4811 (Spendex virtual)
─────────────────────────────────────────
  [ Approve ]   [ Deny ]   [ Always allow Modal ]
```

**User:** clicks **Always allow Modal**

**Agent:**
> Modal trusted. Submitting the fine-tune job...
>
> Job `ft-94c2` running on A10G. I'll ping you when it finishes.

### Dashboard shows

- **`/dashboard/services`** — Modal now appears as a managed service
  - Login email: `signup-7a91f@mail.spendexai.com`
  - Password: `••••••••` (click to reveal — vaulted, AES-256-GCM)
  - [screenshot: services-modal-managed]
- **`/dashboard/consents/preferences`** — Modal moved into the `trusted_services` list
  - [screenshot: trusted-services-modal]
- **`/dashboard/transactions`** — `Modal — $8.40 — A10G runtime — Auto-approved (trusted)`
  - [screenshot: transactions-modal-row]

### What just happened under the hood

1. `signup_to_service` triggered the Identity Broker
2. Email alias minted → password generated → stored encrypted in the vault
3. Computer Use session executed the signup form against `modal.com`
4. Inbound webhook on `mail.spendexai.com` caught the verification email, extracted the link, fed it back to the Computer Use session
5. Modal billing form received the Spendex virtual card; Stripe Issuing approved the `$0` auth probe
6. First real charge ran through `pay_for_service`; consent UX in this case included a "trust this service" toggle
7. Future Modal charges auto-approve under the trust rule — still cap-enforced, still in the audit log

---

## Recap

| Demo | Tools used | Consent mode shown |
|---|---|---|
| 1. Vercel deploy + Pro upgrade | `deploy_to_vercel`, `request_user_consent`, `pay_for_service` | One-shot approval |
| 2. Amazon headphones | `fetch_product_preview`, `request_user_consent`, Computer Use checkout | Per-purchase approval |
| 3. Modal signup | `signup_to_service`, `get_verification_email`, `complete_signup`, `request_user_consent` | Trust-this-service approval |

Every charge ends up in the same audit trail. Every consent ends up in the same history. One relationship — yours with Spendex. We handle the rest.
