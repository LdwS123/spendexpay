/**
 * Stripe Issuing — virtual card lifecycle management.
 *
 * Each Spendex user gets one virtual card issued via Stripe Issuing.
 * The card is charged automatically when an MCP tool triggers a payment.
 * Stripe sends an `issuing_authorization.request` event to our webhook
 * within <2 seconds; we approve or decline there based on spending rules.
 *
 * Flow:
 *   1. User signs up → createVirtualCardForUser() → one Cardholder + one Card
 *   2. Agent calls a tool → Stripe Issuing charges the virtual card
 *   3. Stripe fires issuing_authorization.request → webhook approves/declines
 *   4. User updates max limit → updateCardSpendingLimit()
 *   5. Emergency / user request → freezeCard() / unfreezeCard()
 *
 * All debug output goes to console.error (stderr). stdout belongs to the MCP
 * protocol and must never receive stray bytes.
 */

import Stripe from "stripe";
import { config, DEV_MODE } from "../config.js";

// Re-use the shared Stripe client from the payments module so we share the
// same API version and connection pool across the entire server.
// We import lazily via a getter to avoid constructing the client at module
// load time when STRIPE_SECRET_KEY may not yet be set (dev mode startup).
function getStripe(): Stripe {
  return new Stripe(config.stripe.secretKey, { apiVersion: "2024-06-20" });
}

// Card currency is derived from the STRIPE_CARD_CURRENCY env var.
// Defaults to "eur" for EU accounts — change to "usd" for US accounts.
// Must match the Stripe account's settlement currency or card creation fails.
const CARD_CURRENCY = (process.env.STRIPE_CARD_CURRENCY ?? "eur").toLowerCase();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateVirtualCardResult {
  stripeCardId: string;
  stripeCardholderId: string;
}

/**
 * Create a virtual card for a new Spendex user.
 *
 * Must be called exactly once during user onboarding. Idempotency is the
 * caller's responsibility — calling this twice for the same user will issue
 * two cards, which is wrong. Guard with a DB check before calling.
 *
 * In dev mode: returns fake IDs instantly, no Stripe API calls.
 *
 * @param params.spendingLimitUsd  Maps to max_auto_charge_usd from the user
 *   record. Stripe enforces this as a per-authorization spending control.
 *   The limit is per-authorization (not monthly), matching how the rest of the
 *   payment stack treats max_auto_charge_usd.
 */
export async function createVirtualCardForUser(params: {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  spendingLimitUsd: number;
}): Promise<CreateVirtualCardResult> {
  const { userId, email, firstName, lastName, phoneNumber, spendingLimitUsd } = params;

  if (DEV_MODE) {
    console.error(
      `[stripe-issuing] DEV MODE — skipping real Stripe API calls for user ${userId}. ` +
      `Returning fake card and cardholder IDs.`
    );
    return {
      stripeCardId: `ic_dev_${userId}`,
      stripeCardholderId: `ich_dev_${userId}`,
    };
  }

  const stripe = getStripe();

  // Derive billing country and card currency from the Stripe account's default
  // currency. EU accounts (EUR) require a European billing address and phone
  // number for PSD2/3DS2 compliance; US accounts (USD) use a US address.
  const isEuAccount = CARD_CURRENCY === "eur";
  const billingAddress = isEuAccount
    ? { line1: "1 Spendex Street", city: "Paris", postal_code: "75001", country: "FR" }
    : { line1: "1 Spendex Way", city: "San Francisco", state: "CA", postal_code: "94105", country: "US" };

  let cardholder: Stripe.Issuing.Cardholder;
  try {
    cardholder = await stripe.issuing.cardholders.create({
      type: "individual",
      name: `${firstName} ${lastName}`,
      email,
      phone_number: phoneNumber,
      individual: { first_name: firstName, last_name: lastName },
      billing: { address: billingAddress },
      metadata: { spendex_user_id: userId },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stripe-issuing] createVirtualCardForUser: failed to create Stripe Cardholder ` +
      `for user ${userId}: ${message}`
    );
    throw new Error(`Failed to create Stripe Cardholder for user ${userId}: ${message}`);
  }

  console.error(
    `[stripe-issuing] Created Cardholder cardholder_id="${cardholder.id}" for user ${userId}.`
  );

  const spendingLimitCents = Math.round(spendingLimitUsd * 100);

  // EU accounts: cards are created inactive and must be explicitly activated.
  // US accounts: can pass status="active" directly on create.
  let card: Stripe.Issuing.Card;
  try {
    card = await stripe.issuing.cards.create({
      cardholder: cardholder.id,
      currency: CARD_CURRENCY,
      type: "virtual",
      spending_controls: buildSpendingControls(spendingLimitCents),
      metadata: { spendex_user_id: userId },
    });
    if (card.status === "inactive") {
      card = await stripe.issuing.cards.update(card.id, { status: "active" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stripe-issuing] createVirtualCardForUser: Cardholder created (id="${cardholder.id}") ` +
      `but Card creation failed for user ${userId}: ${message}. ` +
      `The orphaned Cardholder can be cleaned up in the Stripe dashboard.`
    );
    throw new Error(
      `Failed to issue virtual card for user ${userId} (cardholder ${cardholder.id}): ${message}`
    );
  }

  console.error(
    `[stripe-issuing] Issued virtual card card_id="${card.id}" status="${card.status}" ` +
    `cardholder_id="${cardholder.id}" for user ${userId} ` +
    `with spending limit ${spendingLimitCents} cents per authorization.`
  );

  return { stripeCardId: card.id, stripeCardholderId: cardholder.id };
}

/**
 * Update the per-authorization spending limit on an existing virtual card.
 *
 * Called when the user changes their max_auto_charge_usd in the dashboard
 * settings. The new limit takes effect immediately for the next authorization.
 *
 * In dev mode: no-op.
 */
export async function updateCardSpendingLimit(params: {
  stripeCardId: string;
  newLimitUsd: number;
}): Promise<void> {
  const { stripeCardId, newLimitUsd } = params;

  if (DEV_MODE) {
    console.error(
      `[stripe-issuing] DEV MODE — skipping spending limit update for card ${stripeCardId}.`
    );
    return;
  }

  const stripe = getStripe();
  const newLimitCents = Math.round(newLimitUsd * 100);

  try {
    await stripe.issuing.cards.update(stripeCardId, {
      spending_controls: buildSpendingControls(newLimitCents),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stripe-issuing] updateCardSpendingLimit: failed to update card ${stripeCardId} ` +
      `to limit ${newLimitCents} cents: ${message}`
    );
    throw new Error(
      `Failed to update spending limit for card ${stripeCardId}: ${message}`
    );
  }

  console.error(
    `[stripe-issuing] Updated spending limit on card ${stripeCardId} ` +
    `to ${newLimitCents} cents per authorization.`
  );
}

/**
 * Freeze a virtual card immediately.
 *
 * Used by the emergency stop handler or when a user suspends their account.
 * Any authorization attempted while the card is frozen is automatically
 * declined by Stripe — our webhook is NOT called for frozen-card declines.
 *
 * In dev mode: no-op.
 */
export async function freezeCard(stripeCardId: string): Promise<void> {
  if (DEV_MODE) {
    console.error(
      `[stripe-issuing] DEV MODE — skipping freeze for card ${stripeCardId}.`
    );
    return;
  }

  const stripe = getStripe();

  try {
    await stripe.issuing.cards.update(stripeCardId, { status: "inactive" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stripe-issuing] freezeCard: failed to freeze card ${stripeCardId}: ${message}`
    );
    throw new Error(`Failed to freeze card ${stripeCardId}: ${message}`);
  }

  console.error(`[stripe-issuing] Card ${stripeCardId} has been frozen (status=inactive).`);
}

/**
 * Unfreeze a virtual card.
 *
 * Restores a previously frozen card to active status. Authorizations will
 * resume being routed to our webhook for approval/decline decisions.
 *
 * In dev mode: no-op.
 */
export async function unfreezeCard(stripeCardId: string): Promise<void> {
  if (DEV_MODE) {
    console.error(
      `[stripe-issuing] DEV MODE — skipping unfreeze for card ${stripeCardId}.`
    );
    return;
  }

  const stripe = getStripe();

  try {
    await stripe.issuing.cards.update(stripeCardId, { status: "active" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stripe-issuing] unfreezeCard: failed to unfreeze card ${stripeCardId}: ${message}`
    );
    throw new Error(`Failed to unfreeze card ${stripeCardId}: ${message}`);
  }

  console.error(`[stripe-issuing] Card ${stripeCardId} has been unfrozen (status=active).`);
}

/**
 * Sensitive card details returned to the agent in "card_reveal" mode.
 *
 * The PAN and CVC are fetched on demand from Stripe and never persisted by
 * Spendex Pay. The agent is responsible for forwarding these to the merchant
 * exactly once (e.g. typing them into a checkout form) and discarding them.
 */
export interface RevealedCardDetails {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  brand: string;
  last4: string;
}

/**
 * Retrieve a virtual card's sensitive details (PAN + CVC) on demand.
 *
 * Stripe requires the `expand: ["number", "cvc"]` opt-in to return PCI data,
 * and the calling account must have PCI-restricted access enabled. If those
 * fields come back missing we surface a clean error rather than returning
 * `undefined` strings to the agent.
 *
 * In dev mode: returns deterministic placeholder details — realistic enough
 * for the agent to format a response, but never usable for a real charge.
 */
export async function retrieveCardDetails(
  stripeCardId: string
): Promise<RevealedCardDetails> {
  if (DEV_MODE) {
    return {
      number: "4242424242424242",
      expMonth: 12,
      expYear: 2030,
      cvc: "123",
      brand: "Visa",
      last4: "4242",
    };
  }

  const stripe = getStripe();

  let card: Stripe.Issuing.Card;
  try {
    card = await stripe.issuing.cards.retrieve(stripeCardId, {
      expand: ["number", "cvc"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stripe-issuing] retrieveCardDetails: failed to retrieve card ` +
      `${stripeCardId}: ${message}`
    );
    throw new Error(
      `Failed to retrieve card details from Stripe: ${message}`
    );
  }

  // Stripe only returns `number` / `cvc` when the account has PCI-restricted
  // data access enabled AND the `expand` opt-in was sent. Missing values mean
  // the account isn't configured for PAN retrieval — fail loudly so the
  // operator knows to enable it, rather than silently returning `undefined`.
  const number = card.number;
  const cvc = card.cvc;
  if (!number || !cvc) {
    throw new Error(
      "Stripe did not return card number or CVC. The Stripe account may " +
      "not have PCI-restricted data access enabled for this card."
    );
  }

  return {
    number,
    expMonth: card.exp_month,
    expYear: card.exp_year,
    cvc,
    brand: card.brand,
    last4: card.last4,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Allowed Merchant Category Codes for Spendex Pay cards.
 *
 * Stripe v16 MCC string literals for dev-tool vendors:
 *   computer_programming   — 7371 (Vercel, Netlify, Railway, Render, Fly.io, Modal, Replicate)
 *   computer_repair        — 7372 (cloud compute repair/maintenance services)
 *   computer_software_stores — 5045 (software subscriptions, API credits)
 *   computer_network_services — 7375 (CDN, cloud networking)
 *
 * Locking to a specific MCC list means a compromised card cannot be used at
 * unrelated merchants (restaurants, retail, etc.).
 */
const ALLOWED_MCCS: Stripe.Issuing.CardCreateParams.SpendingControls.AllowedCategory[] = [
  "computer_programming",
  "computer_repair",
  "computer_software_stores",
  "computer_network_services",
];

/**
 * Build the spending_controls object for card create/update calls.
 *
 * `spending_limits` restricts the amount per authorization (interval="per_authorization"
 * means each individual charge is capped — not a rolling monthly total).
 * This mirrors how max_auto_charge_usd is described elsewhere in the codebase.
 */
function buildSpendingControls(
  limitCents: number
): Stripe.Issuing.CardCreateParams.SpendingControls {
  return {
    allowed_categories: ALLOWED_MCCS,
    spending_limits: [
      {
        amount: limitCents,
        interval: "per_authorization",
      },
    ],
  };
}
