/**
 * POST /api/settings/profile
 *
 * Updates the user's display name, phone number, and (optionally) email.
 * If the user has a Stripe Issuing cardholder linked to their account,
 * the cardholder name and phone_number are updated in Stripe as well so
 * the name on their virtual card stays in sync.
 *
 * All debug output goes to console.error (stderr).
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Stripe client
// ---------------------------------------------------------------------------

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set. Add it to .env.local.");
  }
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PostBody {
  display_name?: string;
  phone_number?: string;
  email?: string;
}

interface VirtualCardRow {
  stripe_cardholder_id: string;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Authenticate via session cookie
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    console.error("[api/settings/profile] Unauthenticated request.");
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const userId = user.id;

  // Parse body
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { display_name, phone_number, email } = body;

  // Basic validation — at least one field must be provided
  if (!display_name && !phone_number && !email) {
    return NextResponse.json(
      { error: "At least one field (display_name, phone_number, email) is required" },
      { status: 400 }
    );
  }

  if (display_name !== undefined && typeof display_name !== "string") {
    return NextResponse.json({ error: "display_name must be a string" }, { status: 400 });
  }
  if (phone_number !== undefined && typeof phone_number !== "string") {
    return NextResponse.json({ error: "phone_number must be a string" }, { status: 400 });
  }
  if (email !== undefined && typeof email !== "string") {
    return NextResponse.json({ error: "email must be a string" }, { status: 400 });
  }

  // Admin client for DB writes
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/settings/profile] Failed to create admin Supabase client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  // ---------------------------------------------------------------------------
  // 1. Update public.users
  // ---------------------------------------------------------------------------

  const userUpdate: Record<string, string> = {};
  if (display_name) userUpdate.display_name = display_name;
  if (phone_number) userUpdate.phone_number = phone_number;
  if (email && email !== user.email) userUpdate.email = email;

  if (Object.keys(userUpdate).length > 0) {
    const { error: userUpdateError } = await admin
      .from("users")
      .update(userUpdate)
      .eq("id", userId);

    if (userUpdateError) {
      console.error("[api/settings/profile] Failed to update public.users:", userUpdateError);
      return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Update Stripe Issuing cardholder (name + phone) if one exists
  // ---------------------------------------------------------------------------

  // Look up the cardholder ID from virtual_cards table
  const { data: cardData, error: cardLookupError } = await admin
    .from("virtual_cards")
    .select("stripe_cardholder_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (cardLookupError) {
    console.error("[api/settings/profile] Failed to look up virtual_cards:", cardLookupError);
    // Non-fatal — profile was already updated in DB; just skip Stripe sync
    return NextResponse.json({ success: true, stripeUpdated: false }, { status: 200 });
  }

  const card = cardData as VirtualCardRow | null;

  if (card?.stripe_cardholder_id) {
    const cardholderId = card.stripe_cardholder_id;

    // Skip Stripe in dev mode
    if (process.env.SPENDEX_DEV === "true") {
      console.error(
        `[api/settings/profile] DEV MODE — skipping Stripe cardholder update for ${cardholderId}.`
      );
      return NextResponse.json({ success: true, stripeUpdated: false }, { status: 200 });
    }

    // Build Stripe update payload — only include fields that were provided.
    // CardholderUpdateParams does not have a top-level `name` field; the name
    // is set via individual.first_name / individual.last_name.
    const stripeUpdate: Stripe.Issuing.CardholderUpdateParams = {};
    if (display_name) {
      const parts = display_name.trim().split(/\s+/);
      const firstName = parts[0] ?? display_name;
      const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "User";
      stripeUpdate.individual = { first_name: firstName, last_name: lastName };
    }
    if (phone_number) stripeUpdate.phone_number = phone_number;

    if (Object.keys(stripeUpdate).length > 0) {
      try {
        const stripe = getStripe();
        await stripe.issuing.cardholders.update(cardholderId, stripeUpdate);
        console.error(
          `[api/settings/profile] Updated Stripe cardholder ${cardholderId} for user ${userId}.`
        );
        return NextResponse.json({ success: true, stripeUpdated: true }, { status: 200 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[api/settings/profile] Stripe cardholder update failed for ${cardholderId}: ${message}`
        );
        // DB was already updated — return partial success so the UI knows
        return NextResponse.json(
          { success: true, stripeUpdated: false, stripeError: message },
          { status: 200 }
        );
      }
    }
  }

  return NextResponse.json({ success: true, stripeUpdated: false }, { status: 200 });
}
