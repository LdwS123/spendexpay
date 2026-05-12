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

// GET — return the user's current payment method (if any)
export async function GET(): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const admin = getAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("payment_method, payment_provider_customer_id")
    .eq("id", userId)
    .single();

  if (error) return NextResponse.json({ error: "Failed to fetch user" }, { status: 500 });

  if (!data?.payment_provider_customer_id) {
    return NextResponse.json({ paymentMethod: null });
  }

  try {
    const stripe = getStripe();
    const paymentMethods = await stripe.paymentMethods.list({
      customer: data.payment_provider_customer_id,
      type: "card",
      limit: 1,
    });

    const pm = paymentMethods.data[0];
    if (!pm) return NextResponse.json({ paymentMethod: null });

    return NextResponse.json({
      paymentMethod: {
        id: pm.id,
        type: "stripe_card",
        brand: pm.card?.brand ?? "card",
        last4: pm.card?.last4 ?? "????",
        expMonth: pm.card?.exp_month,
        expYear: pm.card?.exp_year,
      },
    });
  } catch (err) {
    console.error("[api/payments] GET: stripe error:", err);
    return NextResponse.json({ error: "Failed to fetch payment methods" }, { status: 500 });
  }
}

// POST /api/payments/setup-intent is in setup-intent/route.ts
// DELETE — detach the payment method
export async function DELETE(req: NextRequest): Promise<NextResponse> {
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
    // No customer on file — caller cannot own any PM; respond identically to mismatch.
    return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
  }

  try {
    const stripe = getStripe();

    // Verify the PM belongs to the authenticated user's Stripe customer before detaching.
    // Return 404 (not 403) on mismatch so we don't expose whether the PM exists.
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== userData.payment_provider_customer_id) {
      return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
    }

    await stripe.paymentMethods.detach(paymentMethodId);
  } catch (err) {
    // Stripe returns StripeInvalidRequestError (404) when the PM doesn't exist; mask as not found.
    if (err instanceof Stripe.errors.StripeError && err.statusCode === 404) {
      return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
    }
    console.error("[api/payments] DELETE: stripe error:", err);
    return NextResponse.json({ error: "Failed to remove payment method" }, { status: 500 });
  }

  await admin.from("users").update({ payment_method: null, payment_provider_customer_id: null }).eq("id", userId);

  return NextResponse.json({ success: true });
}
