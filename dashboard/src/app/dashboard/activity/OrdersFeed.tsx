import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

// ─── types ──────────────────────────────────────────────────────────────────

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

function formatAmount(
  amount: number,
  currency: string | null | undefined
): string {
  return currencySymbol(currency) + amount.toFixed(2);
}

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

function dayKey(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

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

// ─── presentational ─────────────────────────────────────────────────────────

function ServiceBadge({ service }: { service: string }) {
  return (
    <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 uppercase tracking-wide">
      {service}
    </span>
  );
}

function ProductThumb({
  src,
  alt,
}: {
  src: string | null | undefined;
  alt: string;
}) {
  if (src) {
    // Plain <img> rather than next/image so we don't have to declare every
    // merchant domain in next.config.
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

function OrderRow({ order }: { order: Order }) {
  const name =
    order.product_name ?? order.description ?? capitalise(order.service);
  return (
    <Link
      href={`/dashboard/transactions/${order.id}`}
      aria-label={`Order: ${name}, ${
        order.amount_usd != null
          ? formatAmount(order.amount_usd, order.currency)
          : "no amount"
      }`}
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
        {order.product_name &&
          order.description &&
          order.description !== order.product_name && (
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

// ─── feed (server component) ────────────────────────────────────────────────

export default async function OrdersFeed({ userId }: { userId: string }) {
  const supabase = await createClient();

  // We try the migration-005 column set first. If that fails (most likely
  // because the migration has not yet been applied to this environment) we
  // fall back to the base column set so the feed still renders.
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
      .eq("user_id", userId)
      .eq("status", "success")
      .gt("amount_usd", 0)
      .order("created_at", { ascending: false })
      .limit(100);

  const { data, error } = await tryQuery(SELECT_WITH_META);
  if (error) {
    console.error("[activity/orders] Rich query failed, falling back:", error);
    const fallback = await tryQuery(SELECT_BASE);
    if (fallback.error) {
      console.error("[activity/orders] Base query also failed:", fallback.error);
      queryError = fallback.error.message;
    } else {
      orders = (fallback.data ?? []) as unknown as Order[];
    }
  } else {
    orders = (data ?? []) as unknown as Order[];
  }

  // Group by day (newest-first preserved).
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

  if (queryError) {
    return (
      <div className="mb-5 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700">
        Could not load orders: {queryError}
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-100 flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-300">
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              d="M3 5h10l-1 8H4L3 5zM3 5l-.5-2h-1M6 5V3.5a2 2 0 014 0V5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <p className="text-sm font-medium text-slate-600">No orders yet</p>
        <p className="text-xs text-slate-400 mt-1 max-w-sm leading-relaxed">
          Completed purchases appear here after the first successful charge.
        </p>
      </div>
    );
  }

  return (
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
  );
}
