import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import { stripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

// ─── types ────────────────────────────────────────────────────────────────────

interface VirtualCardRow {
  stripe_card_id: string;
  status: string | null;
}

interface RevealedCardResponse {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  brand: string;
  last4: string;
}

interface ErrorResponse {
  error: string;
}

// ─── POST — reveal virtual card details ──────────────────────────────────────
//
// Server-side reveal: pulls the Stripe Issuing card with the `number` and `cvc`
// fields expanded. This is a sensitive endpoint — every successful reveal is
// logged to stderr for the audit trail. We never log the PAN, only the last4
// (which is already exposed via the dashboard's regular surface).
//
// Note on `expand: ['number', 'cvc']`: this requires the Stripe account to be
// allowed PCI-restricted data access. In test mode this works out of the box.
// In live mode you must have completed the PCI compliance attestation in the
// Stripe dashboard. If the call fails for that reason we surface a useful
// message rather than letting the raw Stripe error bubble up.

export async function POST(): Promise<NextResponse<RevealedCardResponse | ErrorResponse>> {
  // 1) Authenticate the request.
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    console.error(
      "[api/services/card-details] POST: unauthenticated reveal attempt"
    );
    return NextResponse.json(
      { error: "Unauthenticated" },
      { status: 401 }
    );
  }

  // 2) Fetch the user's virtual card id from our DB.
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error(
      "[api/services/card-details] POST: failed to create admin client:",
      err
    );
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  let cardRow: VirtualCardRow | null = null;
  try {
    const { data, error } = await admin
      .from("virtual_cards")
      .select("stripe_card_id, status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(
        "[api/services/card-details] POST: virtual_cards query error:",
        error
      );
      return NextResponse.json(
        { error: "Failed to look up virtual card" },
        { status: 500 }
      );
    }
    cardRow = (data ?? null) as VirtualCardRow | null;
  } catch (err) {
    console.error(
      "[api/services/card-details] POST: unexpected DB error:",
      err
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }

  if (!cardRow || !cardRow.stripe_card_id) {
    return NextResponse.json(
      {
        error:
          "No active virtual card found for your account. Provision one from the Payments page first.",
      },
      { status: 404 }
    );
  }

  // 3) Retrieve the full card from Stripe with sensitive fields expanded.
  try {
    const card = await stripe.issuing.cards.retrieve(cardRow.stripe_card_id, {
      expand: ["number", "cvc"],
    });

    // Audit log — successful reveal. Never log the PAN; the last4 is enough
    // to correlate against a specific card during dispute investigation.
    console.error(
      `[api/services/card-details] reveal_success user=${user.id} card=${cardRow.stripe_card_id} last4=${card.last4}`
    );

    // `number` and `cvc` are only present on the response when the request
    // came through with the right PCI scope. If they are absent, surface a
    // clear message rather than returning `undefined` to the client.
    const number = (card as unknown as { number?: string }).number;
    const cvc = (card as unknown as { cvc?: string }).cvc;

    if (!number || !cvc) {
      return NextResponse.json(
        {
          error:
            "Stripe did not return the card number. Your account may not have PCI-restricted data access enabled.",
        },
        { status: 403 }
      );
    }

    const response: RevealedCardResponse = {
      number,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      cvc,
      brand: card.brand,
      last4: card.last4,
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    // Stripe SDK throws StripeError; we surface a friendly message and put
    // the verbose details into stderr only.
    console.error(
      "[api/services/card-details] POST: Stripe retrieve error:",
      err
    );
    const message =
      err instanceof Error
        ? err.message
        : "Failed to retrieve card details from Stripe";
    return NextResponse.json(
      { error: message },
      { status: 502 }
    );
  }
}
