/**
 * Merchant name normalization.
 *
 * Stripe Issuing emits merchant_data.name straight from the card network's
 * descriptor field. These descriptors are notoriously cryptic — "AMZN MKTP",
 * "VERCEL.COM*PRO", "UBER   TRIP" — because the field is fixed-width and
 * was designed for 1980s point-of-sale receipts.
 *
 * `normalizeMerchantName` collapses those raw descriptors into stable slugs
 * we can pivot on: matching `allowed_services` rules, grouping the
 * transactions page by vendor, linking to vendor homepages.
 *
 * The mapping is deliberately keyed on substring matches against the
 * uppercased raw descriptor, because card networks pad / truncate / split
 * names unpredictably. The first match wins — more specific patterns sit
 * higher in the table than generic ones.
 *
 * Anything that doesn't match falls back to a sanitized version of the raw
 * descriptor: lowercased, non-alphanumerics stripped, capped at 20 chars.
 * The fallback is intentionally lossy but stable — same input always
 * produces the same slug, so analytics keeps grouping correctly.
 */

interface MerchantPattern {
  /** Substrings (uppercased) that, if found in the raw descriptor, map to `slug`. */
  patterns: string[];
  /** Canonical slug used everywhere downstream. */
  slug: string;
  /** Public homepage for the vendor, used by the dashboard to render a link. */
  url: string;
}

const MERCHANT_PATTERNS: MerchantPattern[] = [
  // Order matters: longer / more specific patterns first.
  { patterns: ["AMZN MKTP", "AMZN MKTPLACE", "AMAZON MKTP", "AMAZON.COM", "AMZN.COM", "AMAZON"], slug: "amazon", url: "https://www.amazon.com" },
  { patterns: ["VERCEL"], slug: "vercel", url: "https://vercel.com" },
  { patterns: ["MODAL LABS", "MODAL.COM", "MODAL "], slug: "modal", url: "https://modal.com" },
  { patterns: ["OPENAI"], slug: "openai", url: "https://openai.com" },
  { patterns: ["ANTHROPIC"], slug: "anthropic", url: "https://anthropic.com" },
  { patterns: ["GITHUB"], slug: "github", url: "https://github.com" },
  { patterns: ["NETFLIX"], slug: "netflix", url: "https://netflix.com" },
  { patterns: ["SPOTIFY"], slug: "spotify", url: "https://spotify.com" },
  { patterns: ["UBER EATS", "UBEREATS", "UBER TRIP", "UBER"], slug: "uber", url: "https://uber.com" },
  { patterns: ["AIRBNB"], slug: "airbnb", url: "https://airbnb.com" },
  { patterns: ["CLOUDFLARE"], slug: "cloudflare", url: "https://cloudflare.com" },
  { patterns: ["REPLICATE"], slug: "replicate", url: "https://replicate.com" },
  { patterns: ["HUGGINGFACE", "HUGGING FACE", "HF.CO"], slug: "huggingface", url: "https://huggingface.co" },
  { patterns: ["SUPABASE"], slug: "supabase", url: "https://supabase.com" },
  { patterns: ["RAILWAY"], slug: "railway", url: "https://railway.app" },
  { patterns: ["RENDER.COM", "RENDER "], slug: "render", url: "https://render.com" },
  { patterns: ["FLY.IO", "FLY.IO*"], slug: "fly", url: "https://fly.io" },
  { patterns: ["NETLIFY"], slug: "netlify", url: "https://netlify.com" },
  { patterns: ["GAMMA APP", "GAMMA.APP"], slug: "gamma", url: "https://gamma.app" },
];

/**
 * Build a stable slug for a Stripe merchant descriptor.
 *
 * Pure function. No logging, no I/O — safe to call from the webhook hot
 * path where every millisecond counts against Stripe's 2-second budget.
 */
export function normalizeMerchantName(rawName: string | null | undefined): string {
  if (!rawName) return "unknown";

  const upper = rawName.toUpperCase();
  for (const entry of MERCHANT_PATTERNS) {
    if (entry.patterns.some((p) => upper.includes(p))) {
      return entry.slug;
    }
  }

  // Fallback: lowercase + strip non-alphanumeric + cap at 20 chars.
  // Cap is to keep slugs index-friendly and predictable in the UI.
  const sanitized = rawName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!sanitized) return "unknown";
  return sanitized.slice(0, 20);
}

/**
 * Look up a public homepage URL for a normalized slug.
 *
 * Returns null when the slug is the fallback (i.e. the merchant was not in
 * the mapping table). The dashboard uses this to decide whether to render
 * the merchant name as a hyperlink.
 */
export function inferMerchantUrl(slug: string): string | null {
  if (!slug) return null;
  const entry = MERCHANT_PATTERNS.find((p) => p.slug === slug);
  return entry ? entry.url : null;
}
