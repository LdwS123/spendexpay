/**
 * POST /api/onboarding
 *
 * Called after the very first login, when auth.users has a row but public.users
 * does not yet. Creates the public.users row and provisions a Stripe Issuing
 * virtual card for the new user.
 *
 * Idempotency: the handler checks whether a public.users row already exists
 * before doing anything. A second call for the same user is a no-op that
 * returns { success: true, cardCreated: false }.
 *
 * Stripe EU notes:
 *  - Currency must be "eur" for EU-issued accounts (STRIPE_CARD_CURRENCY env var).
 *  - Cardholder requires phone_number and individual.first_name / last_name.
 *  - Cards are created inactive in EU accounts and immediately activated here.
 *
 * All debug output goes to console.error (stderr).
 */

import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import { sendWelcomeEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Stripe client — uses the dashboard's STRIPE_SECRET_KEY
// ---------------------------------------------------------------------------

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set. Add it to .env.local.");
  }
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

// Card currency defaults to "eur" for EU Stripe accounts.
// Override via STRIPE_CARD_CURRENCY env var.
const CARD_CURRENCY = (process.env.STRIPE_CARD_CURRENCY ?? "eur").toLowerCase();

// MCC allowlist — dev-tool vendors only, mirrors the MCP server's stripe-issuing.ts
const ALLOWED_MCCS: Stripe.Issuing.CardCreateParams.SpendingControls.AllowedCategory[] = [
  "computer_programming",
  "computer_repair",
  "computer_software_stores",
  "computer_network_services",
];

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(): Promise<NextResponse> {
  // Authenticate via the session cookie — this is a user-initiated call.
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    console.error("[api/onboarding] Unauthenticated request.");
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const userId = user.id;
  const email = user.email ?? "";

  // Use the service-role client for writes to public.users — the anon client
  // cannot insert rows there without a permissive RLS policy.
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/onboarding] Failed to create admin Supabase client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  // ---------------------------------------------------------------------------
  // Idempotency check — bail early if the row already exists
  // ---------------------------------------------------------------------------

  const { data: existingRow, error: lookupError } = await admin
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (lookupError) {
    console.error(
      `[api/onboarding] DB lookup failed for user ${userId}:`,
      lookupError
    );
    return NextResponse.json(
      { error: "Database error during user lookup" },
      { status: 500 }
    );
  }

  if (existingRow) {
    console.error(
      `[api/onboarding] User ${userId} already has a public.users row. No-op.`
    );
    return NextResponse.json({ success: true, cardCreated: false }, { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Derive display name from email (placeholder until user sets real name)
  // ---------------------------------------------------------------------------

  const emailLocalPart = email.split("@")[0] ?? "user";
  // Capitalise first letter and strip non-alpha chars for a reasonable name
  const firstName =
    emailLocalPart.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) || "User";
  const lastName = "User";
  // Placeholder EU phone number — user can update in Settings
  const phoneNumber = "+33600000000";

  // ---------------------------------------------------------------------------
  // Provision Stripe Issuing cardholder + virtual card
  // ---------------------------------------------------------------------------

  let stripeCardholderId: string | null = null;
  let stripeCardId: string | null = null;
  let cardCreated = false;

  if (process.env.SPENDEX_DEV === "true") {
    // Dev mode — skip real Stripe calls
    stripeCardholderId = `ich_dev_${userId}`;
    stripeCardId = `ic_dev_${userId}`;
    cardCreated = true;
    console.error(
      `[api/onboarding] DEV MODE — using fake Stripe IDs for user ${userId}.`
    );
  } else {
    const stripe = getStripe();
    const isEuAccount = CARD_CURRENCY === "eur";

    const billingAddress = isEuAccount
      ? {
          line1: "1 Spendex Street",
          city: "Paris",
          postal_code: "75001",
          country: "FR" as const,
        }
      : {
          line1: "1 Spendex Way",
          city: "San Francisco",
          state: "CA",
          postal_code: "94105",
          country: "US" as const,
        };

    // Create cardholder
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
      stripeCardholderId = cardholder.id;
      console.error(
        `[api/onboarding] Created Stripe Cardholder cardholder_id="${cardholder.id}" for user ${userId}.`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[api/onboarding] Failed to create Stripe Cardholder for user ${userId}: ${message}`
      );
      // Still create the public.users row without a card — user can retry from settings.
      stripeCardholderId = null;
    }

    // Create virtual card (only if cardholder succeeded)
    if (stripeCardholderId) {
      try {
        let card = await stripe.issuing.cards.create({
          cardholder: stripeCardholderId,
          currency: CARD_CURRENCY,
          type: "virtual",
          spending_controls: {
            allowed_categories: ALLOWED_MCCS,
            // No spending_limits set — our webhook handles approve/decline per-authorization.
            // The user's max_auto_charge_usd is enforced at the webhook layer.
          },
          metadata: { spendex_user_id: userId },
        });

        // EU cards are created inactive — activate immediately
        if (card.status === "inactive") {
          card = await stripe.issuing.cards.update(card.id, { status: "active" });
        }

        stripeCardId = card.id;
        cardCreated = true;
        console.error(
          `[api/onboarding] Issued virtual card card_id="${card.id}" status="${card.status}" ` +
          `cardholder_id="${stripeCardholderId}" for user ${userId}.`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[api/onboarding] Cardholder created (id="${stripeCardholderId}") but card creation ` +
          `failed for user ${userId}: ${message}. Orphaned cardholder — clean up in Stripe dashboard.`
        );
        // Proceed without a card; row is still created with cardholder_id so
        // a retry can pick up from here.
        stripeCardId = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Insert public.users row
  // ---------------------------------------------------------------------------

  const { error: insertError } = await admin.from("users").insert({
    id: userId,
    email,
    max_auto_charge_usd: 0,
    created_at: new Date().toISOString(),
  });


  if (insertError) {
    // If this is a unique-constraint violation, another request beat us to it —
    // treat as idempotent success rather than an error.
    if (insertError.code === "23505") {
      console.error(
        `[api/onboarding] Race condition: public.users row for ${userId} was inserted ` +
        `by a concurrent request. Treating as success.`
      );
      return NextResponse.json({ success: true, cardCreated: false }, { status: 200 });
    }

    console.error(
      `[api/onboarding] Failed to insert public.users row for user ${userId}:`,
      insertError
    );
    return NextResponse.json(
      { error: "Failed to create user record" },
      { status: 500 }
    );
  }

  console.error(
    `[api/onboarding] Created public.users row for user ${userId} ` +
    `(cardCreated=${cardCreated}).`
  );

  if (email) {
    void sendWelcomeEmail({ to: email, displayName: firstName });
  }

  // Record the virtual card in the virtual_cards table (separate from users)
  if (stripeCardId && stripeCardholderId) {
    const { error: cardInsertError } = await admin.from("virtual_cards").insert({
      user_id: userId,
      stripe_card_id: stripeCardId,
      stripe_cardholder_id: stripeCardholderId,
      status: "active",
    });
    if (cardInsertError) {
      console.error(`[api/onboarding] Failed to insert virtual_cards row:`, cardInsertError);
    }
  }

  return NextResponse.json({ success: true, cardCreated }, { status: 201 });
}
