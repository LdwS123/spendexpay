/**
 * POST   /api/wallet/freeze   — freeze (set Stripe Issuing card to inactive)
 * DELETE /api/wallet/freeze   — unfreeze (set back to active)
 *
 * Both endpoints:
 *   - Require an authenticated Supabase session
 *   - Look up the user's most recent virtual card (matching by user_id)
 *   - Update the Stripe Issuing card status
 *   - Update the local `virtual_cards.status` mirror
 *   - Write an audit_logs entry with transaction_type='card_freeze' so a
 *     freeze/unfreeze action shows up in the same ledger as charges. This
 *     is essential for disputes ("the card was frozen at 14:32, the
 *     authorisation came in at 14:35 — that's why it declined").
 *
 * Freezing does NOT require 2FA. Freezing is a defensive action — making
 * it harder to freeze a compromised card would be the wrong trade-off.
 * Unfreezing also doesn't require 2FA at this stage (V1); we may revisit
 * once the threat model is clearer.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import { stripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

interface VirtualCardRow {
  id: string;
  stripe_card_id: string;
  status: string;
}

async function setStatus(
  nextStripeStatus: "active" | "inactive"
): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const admin = getAdminClient();

  // We pick the user's most recent card regardless of current status — a
  // user might be unfreezing a card we previously froze, so filtering by
  // status='active' would hide the row we need to update.
  const { data: card, error: readError } = await admin
    .from("virtual_cards")
    .select("id, stripe_card_id, status")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<VirtualCardRow>();

  if (readError) {
    console.error("[api/wallet/freeze] DB read error:", readError);
    return NextResponse.json({ error: "Failed to look up card" }, { status: 500 });
  }
  if (!card) {
    return NextResponse.json({ error: "No virtual card on file" }, { status: 404 });
  }

  // Update Stripe first. If this fails, we leave the DB untouched — the
  // mirror row is allowed to lag for a few seconds rather than diverge
  // permanently in the wrong direction.
  try {
    await stripe.issuing.cards.update(card.stripe_card_id, {
      status: nextStripeStatus,
    });
  } catch (err) {
    console.error("[api/wallet/freeze] Stripe update failed:", err);
    return NextResponse.json(
      { error: "Failed to update card status" },
      { status: 500 }
    );
  }

  const { error: updateError } = await admin
    .from("virtual_cards")
    .update({ status: nextStripeStatus })
    .eq("id", card.id);

  if (updateError) {
    // Stripe is the source of truth; the dashboard refetches from Stripe
    // on the services page so this drift is self-healing. We still report
    // success here so the user's UI lands in the correct state.
    console.error("[api/wallet/freeze] DB mirror update failed:", updateError);
  }

  // Audit log — required for dispute resolution. We deliberately set
  // status='success' (the freeze itself succeeded) and use transaction_type
  // so the dashboard can render this row differently from a charge.
  const { error: auditError } = await admin.from("audit_logs").insert({
    user_id: user.id,
    service: "spendex",
    status: "success",
    amount_usd: 0,
    transaction_type: "card_freeze",
    description:
      nextStripeStatus === "inactive" ? "Virtual card frozen" : "Virtual card unfrozen",
  });
  if (auditError) {
    // We do NOT fail the request on audit log error — the user's intent
    // (the freeze) is already fulfilled at Stripe. We log loudly so the
    // gap is visible in stderr.
    console.error("[api/wallet/freeze] audit log insert failed:", auditError);
  }

  return NextResponse.json({
    status: nextStripeStatus,
  });
}

export async function POST(): Promise<NextResponse> {
  return setStatus("inactive");
}

export async function DELETE(): Promise<NextResponse> {
  return setStatus("active");
}
