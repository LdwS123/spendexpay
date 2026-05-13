import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// ─── types ──────────────────────────────────────────────────────────────────

// Base columns guaranteed to exist on audit_logs (migration 001).
interface AuditLogBase {
  id: string;
  created_at: string;
  user_id: string;
  service: string;
  status: string;
  amount_usd: number | null;
  description: string | null;
  transaction_id: string | null;
}

// Optional product-preview columns (migration 005). These may be absent in
// environments where that migration has not yet run — we handle that case
// in the fetch logic below.
interface AuditLogProductMeta {
  product_url?: string | null;
  product_name?: string | null;
  product_image_url?: string | null;
  currency?: string | null;
  merchant_country?: string | null;
}

type Order = AuditLogBase & AuditLogProductMeta;

// ─── helpers ────────────────────────────────────────────────────────────────

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function currencySymbol(code: string | null | undefined): string {
  switch ((code ?? "USD").toUpperCase()) {
    case "USD":
      return "$";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    case "JPY":
      return "¥";
    default:
      return (code ?? "USD").toUpperCase() + " ";
  }
}

function formatAmount(amount: number, currency: string | null | undefined): string {
  return currencySymbol(currency) + amount.toFixed(2);
}

// "Today", "Yesterday", or "12 May 2026" — used for the day-group headings.
function formatDayHeading(isoDate: string): string {
  const d = new Date(isoDate);
  const now = new Date();

  const startOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

  const today = startOf(now);
  const target = startOf(d);
  const dayMs = 24 * 60 * 60 * 1000;

  if (target === today) return "Today";
  if (target === today - dayMs) return "Yesterday";

  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Stable key for grouping rows by calendar day in the user's local time.
function dayKey(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// "2h ago", "yesterday", "3d ago", "12 May" — compact, never shows clock time.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));

  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;

  const diffDays = Math.floor(diffSec / 86400);
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

// ─── service badge ──────────────────────────────────────────────────────────

function ServiceBadge({ service }: { service: string }) {
  return (
    <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 uppercase tracking-wide">
      {service}
    </span>
  );
}

// ─── product thumbnail (with emoji fallback) ────────────────────────────────

function ProductThumb({ src, alt }: { src: string | null | undefined; alt: string }) {
  if (src) {
    // Use a plain <img> rather than next/image so we don't need to configure
    // remote patterns for every merchant domain (Amazon, Shopify, Stripe, …).
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        className="w-16 h-16 rounded-lg object-cover bg-slate-50 border border-slate-100 shrink-0"
        loading="lazy"
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className="w-16 h-16 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center text-2xl shrink-0"
    >
      <span role="img" aria-label="package">
        📦
      </span>
    </div>
  );
}

// ─── order row ──────────────────────────────────────────────────────────────

function OrderRow({ order }: { order: Order }) {
  const name = order.product_name ?? order.description ?? capitalise(order.service);

  return (
    <Link
      href={`/dashboard/transactions/${order.id}`}
      aria-label={`Order: ${name}, ${order.amount_usd != null ? formatAmount(order.amount_usd, order.currency) : "no amount"}`}
      className="flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-4 border-b border-slate-50 last:border-b-0 hover:bg-slate-50/60 transition-colors cursor-pointer group min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6D5BFF] focus-visible:ring-inset"
    >
      <ProductThumb src={order.product_image_url} alt={name} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-[#0D0F14] truncate max-w-md">
            {name}
          </span>
          <ServiceBadge service={order.service} />
        </div>
        {order.product_name && order.description && order.description !== order.product_name && (
          <p className="text-xs text-slate-500 mt-1 truncate max-w-md">
            {order.description}
          </p>
        )}
        <p className="text-[11px] text-slate-500 mt-1">
          {formatRelative(order.created_at)}
        </p>
      </div>

      <div className="hidden sm:flex flex-col items-end shrink-0">
        <span className="text-base font-semibold text-[#0D0F14] tabular-nums">
          {order.amount_usd != null
            ? formatAmount(order.amount_usd, order.currency)
            : "—"}
        </span>
        <span className="text-[11px] text-[#6D5BFF] group-hover:text-[#0D0F14] transition-colors mt-1">
          View details →
        </span>
      </div>

      {/* mobile-only compact amount + chevron */}
      <div className="flex sm:hidden flex-col items-end shrink-0">
        <span className="text-sm font-semibold text-[#0D0F14] tabular-nums">
          {order.amount_usd != null
            ? formatAmount(order.amount_usd, order.currency)
            : "—"}
        </span>
      </div>
    </Link>
  );
}

// ─── stat card ──────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-5">
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
        {label}
      </p>
      <p className="text-2xl font-semibold text-[#0D0F14] mt-2 tabular-nums">
        {value}
      </p>
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

export default async function OrdersPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // We try once with the new product-meta columns. If that fails (most
  // likely because migration 005 hasn't been applied to this environment
  // yet) we fall back to the base column set so the page still renders.
  const SELECT_WITH_META =
    "id, created_at, user_id, service, status, amount_usd, description, transaction_id, product_url, product_name, product_image_url, currency, merchant_country";
  const SELECT_BASE =
    "id, created_at, user_id, service, status, amount_usd, description, transaction_id";

  let orders: Order[] = [];
  let queryError: string | null = null;

  const tryQuery = async (selectCols: string) =>
    supabase
      .from("audit_logs")
      .select(selectCols)
      .eq("user_id", user.id)
      .eq("status", "success")
      .gt("amount_usd", 0)
      .order("created_at", { ascending: false })
      .limit(100);

  const { data, error } = await tryQuery(SELECT_WITH_META);

  if (error) {
    // Common Postgres error code for missing column is 42703.
    // We catch any error from the rich query and retry with the base columns
    // — this keeps the page rendering until the operator applies migration 005.
    console.error("[orders/page] Rich query failed, falling back:", error);
    const fallback = await tryQuery(SELECT_BASE);
    if (fallback.error) {
      console.error("[orders/page] Base query also failed:", fallback.error);
      queryError = fallback.error.message;
    } else {
      orders = (fallback.data ?? []) as unknown as Order[];
    }
  } else {
    orders = (data ?? []) as unknown as Order[];
  }

  // ── stats ────────────────────────────────────────────────────────────────
  const totalSpent = orders.reduce((sum, o) => sum + (o.amount_usd ?? 0), 0);
  const totalOrders = orders.length;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const thisMonthSpent = orders
    .filter((o) => new Date(o.created_at).getTime() >= startOfMonth)
    .reduce((sum, o) => sum + (o.amount_usd ?? 0), 0);

  // ── group by day ─────────────────────────────────────────────────────────
  // We preserve the original "newest first" order by walking the array in
  // sequence and pushing into ordered groups keyed by day.
  const groups: { key: string; heading: string; items: Order[] }[] = [];
  for (const order of orders) {
    const key = dayKey(order.created_at);
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, heading: formatDayHeading(order.created_at), items: [] };
      groups.push(group);
    }
    group.items.push(order);
  }

  return (
    <main>
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Ledger
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0D0F14]">
              Orders
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Purchases grouped by merchant, amount, and source account.
          </p>
        </div>
        {totalOrders > 0 && (
          <span className="text-xs text-slate-500 shrink-0">
            {totalOrders} {totalOrders === 1 ? "order" : "orders"}
          </span>
        )}
        </div>
      </header>

      <div className="max-w-6xl px-4 py-7 sm:px-8">
        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-7">
          <StatCard
            label="Total spent"
            value={"$" + totalSpent.toFixed(2)}
            hint="Across all merchants"
          />
          <StatCard
            label="Total orders"
            value={String(totalOrders)}
            hint={totalOrders === 1 ? "Single purchase" : "All time"}
          />
          <StatCard
            label="This month"
            value={"$" + thisMonthSpent.toFixed(2)}
            hint={now.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
          />
        </div>

        {queryError && (
          <div className="mb-5 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700">
            Could not load orders: {queryError}
          </div>
        )}

        {/* Orders list */}
        {orders.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-100 flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-300">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M3 5h10l-1 8H4L3 5zM3 5l-.5-2h-1M6 5V3.5a2 2 0 014 0V5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="text-sm font-medium text-slate-600">No orders yet</p>
            <p className="text-xs text-slate-400 mt-1 max-w-sm leading-relaxed">
              Completed purchases appear here after the first successful charge.
            </p>
          </div>
        ) : (
          <div className="space-y-7">
            {groups.map((group) => (
              <section key={group.key}>
                <div className="flex items-center justify-between mb-2.5 px-1">
                  <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
                    {group.heading}
                  </h2>
                  <span className="text-[11px] text-slate-400 tabular-nums">
                    {"$" +
                      group.items
                        .reduce((sum, o) => sum + (o.amount_usd ?? 0), 0)
                        .toFixed(2)}
                  </span>
                </div>
                <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
                  {group.items.map((order) => (
                    <OrderRow key={order.id} order={order} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
