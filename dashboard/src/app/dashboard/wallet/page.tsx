import Stripe from "stripe";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import ServicesClient, {
  type VirtualCardSummary,
} from "../services/ServicesClient";
import PaymentsClient from "../payments/PaymentsClient";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Wallet — single page that merges the legacy "Virtual card" and "Funding"
// surfaces. The user thinks of their wallet as one thing (the card that
// pays + the source that backs it). Splitting it across two sidebar entries
// was redundant; we now stack the two existing client components inside
// one page with section labels.
// ─────────────────────────────────────────────────────────────────────────────

interface VirtualCardRow {
  stripe_card_id: string;
}

interface AuditLogServiceRow {
  service: string;
}

interface SavedPaymentMethod {
  id: string;
  type: string;
  brand: string;
  last4: string;
  expMonth?: number;
  expYear?: number;
}

async function getVirtualCard(
  userId: string
): Promise<{ card: VirtualCardSummary | null; usedServices: string[] }> {
  let card: VirtualCardSummary | null = null;
  let usedServices: string[] = [];

  try {
    const admin = getAdminClient();

    const { data: cardRow, error: cardError } = await admin
      .from("virtual_cards")
      .select("stripe_card_id")
      .eq("user_id", userId)
      .neq("status", "canceled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cardError) {
      console.error("[dashboard/wallet] virtual_cards query error:", cardError);
    } else if (cardRow) {
      const { stripe_card_id } = cardRow as VirtualCardRow;
      try {
        const { stripe } = await import("@/lib/stripe");
        const stripeCard = await stripe.issuing.cards.retrieve(stripe_card_id);
        card = {
          last4: stripeCard.last4,
          brand: stripeCard.brand,
          status: stripeCard.status === "active" ? "active" : "inactive",
        };
      } catch (err) {
        console.error(
          "[dashboard/wallet] failed to fetch Stripe card metadata:",
          err
        );
        card = { last4: "••••", brand: "Visa", status: "active" };
      }
    }

    const { data: auditRows, error: auditError } = await admin
      .from("audit_logs")
      .select("service")
      .eq("user_id", userId);

    if (auditError) {
      console.error(
        "[dashboard/wallet] audit_logs query error:",
        auditError
      );
    } else if (auditRows) {
      const rows = auditRows as AuditLogServiceRow[];
      usedServices = Array.from(
        new Set(rows.map((r) => r.service).filter((s): s is string => !!s))
      );
    }
  } catch (err) {
    console.error("[dashboard/wallet] failed to fetch initial state:", err);
  }

  return { card, usedServices };
}

async function getInitialPaymentMethod(
  userId: string
): Promise<SavedPaymentMethod | null> {
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch {
    return null;
  }

  const { data } = await admin
    .from("users")
    .select("payment_provider_customer_id")
    .eq("id", userId)
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

export default async function WalletPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [{ card, usedServices }, initialMethod] = await Promise.all([
    getVirtualCard(user.id),
    getInitialPaymentMethod(user.id),
  ]);

  return (
    <main>
      {/* The two child client components each render their own <header> and
          page chrome. We render them in sequence inside a single scroll
          container so the user gets one stacked Wallet view. The visual
          separator between the two sections is the second <header> band. */}
      <ServicesClient card={card} usedServices={usedServices} />
      <PaymentsClient initialMethod={initialMethod} />
    </main>
  );
}
