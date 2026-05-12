import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

async function getAuthedUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user.id;
}

// POST — called after Stripe Elements confirms the SetupIntent client-side.
// Marks the payment method as default on the Customer and updates the users row.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { paymentMethodId?: unknown }).paymentMethodId !== "string"
  ) {
    return NextResponse.json({ error: "paymentMethodId required" }, { status: 400 });
  }
  const { paymentMethodId } = parsed as { paymentMethodId: string };

  const admin = getAdminClient();
  const { data: userData, error: userError } = await admin
    .from("users")
    .select("payment_provider_customer_id")
    .eq("id", userId)
    .single();

  if (userError || !userData?.payment_provider_customer_id) {
    return NextResponse.json({ error: "No Stripe customer found for user" }, { status: 400 });
  }

  const stripe = getStripe();

  try {
    // Verify the PM belongs to this user's Stripe customer before granting it default status.
    // Return 404 (not 403) on mismatch so we don't expose whether the PM exists.
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== userData.payment_provider_customer_id) {
      return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
    }

    // Set as the customer's default payment method so future off-session charges work
    await stripe.customers.update(userData.payment_provider_customer_id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const brand = pm.card?.brand ?? "card";

    const { error: updateError } = await admin
      .from("users")
      .update({ payment_method: "stripe_card" })
      .eq("id", userId);

    if (updateError) {
      console.error("[api/payments/confirm] DB update error:", updateError);
      return NextResponse.json({ error: "Failed to save payment method" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      paymentMethod: {
        id: pm.id,
        type: "stripe_card",
        brand,
        last4: pm.card?.last4 ?? "????",
        expMonth: pm.card?.exp_month,
        expYear: pm.card?.exp_year,
      },
    });
  } catch (err) {
    // Stripe returns StripeInvalidRequestError (404) when the PM doesn't exist; mask as not found.
    if (err instanceof Stripe.errors.StripeError && err.statusCode === 404) {
      return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/payments/confirm] stripe error:", msg);
    return NextResponse.json({ error: "Failed to save payment method" }, { status: 500 });
  }
}
