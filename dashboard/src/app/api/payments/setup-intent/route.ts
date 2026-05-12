import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

async function getAuthedUser(): Promise<{ id: string; email: string } | null> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  return { id: user.id, email: user.email ?? "" };
}

// POST — create a SetupIntent so the client can collect and save a card
export async function POST(): Promise<NextResponse> {
  const authUser = await getAuthedUser();
  if (!authUser) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const admin = getAdminClient();
  const { data: userData } = await admin
    .from("users")
    .select("payment_provider_customer_id")
    .eq("id", authUser.id)
    .maybeSingle();

  const stripe = getStripe();
  let customerId: string = userData?.payment_provider_customer_id ?? "";

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: authUser.email,
      metadata: { spendex_user_id: authUser.id },
    });
    customerId = customer.id;

    // Upsert so it works whether or not the users row exists yet
    const { error: upsertError } = await admin
      .from("users")
      .upsert({ id: authUser.id, email: authUser.email, payment_provider_customer_id: customerId }, { onConflict: "id" });

    if (upsertError) {
      console.error("[api/payments/setup-intent] failed to save customer id:", upsertError);
      return NextResponse.json({ error: "Failed to create customer" }, { status: 500 });
    }
  }

  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
    });

    return NextResponse.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/payments/setup-intent] stripe error:", msg);
    return NextResponse.json({ error: "Failed to create setup intent" }, { status: 500 });
  }
}
