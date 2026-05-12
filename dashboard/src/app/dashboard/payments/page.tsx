import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import PaymentsClient from "./PaymentsClient";

export const dynamic = "force-dynamic";

async function getInitialPaymentMethod() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = getAdminClient();
  const { data } = await admin
    .from("users")
    .select("payment_provider_customer_id")
    .eq("id", user.id)
    .single();

  if (!data?.payment_provider_customer_id) return null;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;

  try {
    const stripe = new Stripe(key, { apiVersion: "2025-02-24.acacia" });
    const paymentMethods = await stripe.paymentMethods.list({
      customer: data.payment_provider_customer_id,
      type: "card",
      limit: 1,
    });

    const pm = paymentMethods.data[0];
    if (!pm) return null;

    return {
      id: pm.id,
      type: "stripe_card",
      brand: pm.card?.brand ?? "card",
      last4: pm.card?.last4 ?? "????",
      expMonth: pm.card?.exp_month,
      expYear: pm.card?.exp_year,
    };
  } catch {
    return null;
  }
}

export default async function PaymentsPage() {
  const initialMethod = await getInitialPaymentMethod();
  return <PaymentsClient initialMethod={initialMethod} />;
}
