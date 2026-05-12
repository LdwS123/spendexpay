import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import ServicesClient, { type VirtualCardSummary } from "./ServicesClient";

export const dynamic = "force-dynamic";

interface VirtualCardRow {
  stripe_card_id: string;
}

interface AuditLogServiceRow {
  service: string;
}

export default async function ServicesPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // We render the page in a safe state when any sub-query fails — the user
  // still sees the destinations grid and can navigate to /payments to
  // provision a card. The reveal endpoint will surface a clear error if
  // they try to reveal a non-existent card.
  let card: VirtualCardSummary | null = null;
  let usedServices: string[] = [];

  try {
    const admin = getAdminClient();

    // 1) Virtual card summary — we only need brand + last4 server-side.
    //    The PAN is fetched on demand via /api/services/card-details.
    const { data: cardRow, error: cardError } = await admin
      .from("virtual_cards")
      .select("stripe_card_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cardError) {
      console.error(
        "[dashboard/services] virtual_cards query error:",
        cardError
      );
    } else if (cardRow) {
      // Pull brand + last4 from Stripe so we always render fresh metadata
      // (e.g. after a card replacement the last4 changes but our DB only
      // holds the stripe_card_id).
      const { stripe_card_id } = cardRow as VirtualCardRow;
      try {
        const { stripe } = await import("@/lib/stripe");
        const stripeCard = await stripe.issuing.cards.retrieve(stripe_card_id);
        card = {
          last4: stripeCard.last4,
          brand: stripeCard.brand,
        };
      } catch (err) {
        console.error(
          "[dashboard/services] failed to fetch Stripe card metadata:",
          err
        );
        // Even without Stripe metadata we want to render the card shell.
        card = { last4: "••••", brand: "Visa" };
      }
    }

    // 2) Services that have already been used — distinct `service` from
    //    audit_logs for this user. We render a "Used" badge for these.
    const { data: auditRows, error: auditError } = await admin
      .from("audit_logs")
      .select("service")
      .eq("user_id", user.id);

    if (auditError) {
      console.error(
        "[dashboard/services] audit_logs query error:",
        auditError
      );
    } else if (auditRows) {
      const rows = auditRows as AuditLogServiceRow[];
      usedServices = Array.from(
        new Set(rows.map((r) => r.service).filter((s): s is string => !!s))
      );
    }
  } catch (err) {
    console.error("[dashboard/services] failed to fetch initial state:", err);
  }

  return <ServicesClient card={card} usedServices={usedServices} />;
}
