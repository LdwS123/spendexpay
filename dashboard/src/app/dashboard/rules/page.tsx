"use client";

import { useState, useEffect, useId, useMemo } from "react";

type SaveState = "idle" | "saving" | "saved" | "error";

interface RulesPayload {
  max_auto_charge_usd: number;
  monthly_budget: number;
  allowed_services: string[] | null;
  blocked_services: string[] | null;
  per_service_limits: PerServiceLimit[];
}

interface PerServiceLimit {
  service: string;
  monthly_cap_usd?: number | null;
  per_tx_cap_usd?: number | null;
  blocked?: boolean;
}

// Curated list of merchants users most often want caps for. The "+" labels
// double as the inline icons; keeping them as text emoji avoids dragging in
// an icon set just for this page.
const COMMON_SERVICES: ReadonlyArray<{ slug: string; label: string; icon: string }> = [
  { slug: "vercel", label: "Vercel", icon: "▲" },
  { slug: "modal", label: "Modal", icon: "⚡" },
  { slug: "openai", label: "OpenAI", icon: "✨" },
  { slug: "anthropic", label: "Anthropic", icon: "✦" },
  { slug: "amazon", label: "Amazon", icon: "📦" },
  { slug: "github", label: "GitHub", icon: "⌥" },
  { slug: "cloudflare", label: "Cloudflare", icon: "☁" },
];

// ─── MCC catalogue ────────────────────────────────────────────────────────────
// Mirrors ALLOWED_MCCS in src/lib/stripe-issuing.ts. These are the categories
// the virtual card is locked to at issuance — they cannot be widened from the
// dashboard, only narrowed (planned).
const MCC_CATEGORIES = [
  {
    id: "computer_programming",
    label: "Computer programming",
    description: "Vercel, Modal, Railway, Fly.io, Render, Netlify",
  },
  {
    id: "computer_software_stores",
    label: "Computer software stores",
    description: "API subscriptions, SaaS, software licenses",
  },
  {
    id: "computer_network_services",
    label: "Cloud network services",
    description: "CDN, hosting, cloud networking",
  },
  {
    id: "computer_repair",
    label: "Computer repair & maintenance",
    description: "Infrastructure repair and maintenance services",
  },
] as const;

const PER_TX_PRESETS = [10, 50, 100, 500];
const MONTHLY_PRESETS = [100, 500, 1000, 5000];

// Currency display: cards default to EUR for EU accounts in this codebase.
const CURRENCY_SYMBOL = "€";

export default function RulesPage() {
  // form state
  const [monthlyBudget, setMonthlyBudget] = useState("500");
  const [perTx, setPerTx] = useState("0");
  const [blockedMerchants, setBlockedMerchants] = useState<string[]>([]);
  const [merchantDraft, setMerchantDraft] = useState("");

  // ── Per-service limits state ─────────────────────────────────────────
  // Keyed by service slug for O(1) updates from the UI. Re-serialized into
  // an array shape on save / from the API on load.
  const [perServiceLimits, setPerServiceLimits] = useState<Record<string, PerServiceLimit>>({});
  const [customServiceDraft, setCustomServiceDraft] = useState("");

  // Stable ids for label/input association — required for screen readers
  // to announce the field name when the input receives focus.
  const perTxId = useId();
  const monthlyId = useId();
  const merchantId = useId();

  // UI state
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load current rules on mount
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/rules");
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          max_auto_charge_usd: number | null;
          monthly_budget: number | null;
          allowed_services: string[] | null;
          blocked_services: string[] | null;
          per_service_limits?: PerServiceLimit[];
        };

        if (cancelled) return;

        if (data.max_auto_charge_usd !== null && data.max_auto_charge_usd !== undefined) {
          setPerTx(String(data.max_auto_charge_usd));
        }
        if (data.monthly_budget !== null && data.monthly_budget !== undefined) {
          setMonthlyBudget(String(data.monthly_budget));
        }
        if (Array.isArray(data.blocked_services)) {
          setBlockedMerchants(data.blocked_services);
        }
        if (Array.isArray(data.per_service_limits)) {
          const map: Record<string, PerServiceLimit> = {};
          for (const entry of data.per_service_limits) {
            map[entry.service.toLowerCase()] = entry;
          }
          setPerServiceLimits(map);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load rules";
          setLoadError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  function addMerchant() {
    const trimmed = merchantDraft.trim().toLowerCase();
    if (!trimmed) return;
    if (blockedMerchants.includes(trimmed)) {
      setMerchantDraft("");
      return;
    }
    setBlockedMerchants((prev) => [...prev, trimmed]);
    setMerchantDraft("");
  }

  function removeMerchant(name: string) {
    setBlockedMerchants((prev) => prev.filter((m) => m !== name));
  }

  // ── Per-service helpers ───────────────────────────────────────────────
  // All updates flow through the same setter so the keyed Record stays in
  // sync with the lower-case slug we send to the API.

  function setPerServiceField(
    service: string,
    field: "monthly_cap_usd" | "per_tx_cap_usd",
    rawValue: string
  ) {
    const slug = service.toLowerCase();
    setPerServiceLimits((prev) => {
      const next: PerServiceLimit = { ...(prev[slug] ?? { service: slug }) };
      const parsed = parseFloat(rawValue);
      if (rawValue === "" || !Number.isFinite(parsed) || parsed <= 0) {
        next[field] = null;
      } else {
        next[field] = parsed;
      }
      return { ...prev, [slug]: next };
    });
  }

  function togglePerServiceBlocked(service: string) {
    const slug = service.toLowerCase();
    setPerServiceLimits((prev) => {
      const current = prev[slug] ?? { service: slug };
      return { ...prev, [slug]: { ...current, blocked: !current.blocked } };
    });
  }

  function addCustomPerService() {
    const slug = customServiceDraft.trim().toLowerCase();
    if (!slug) return;
    setPerServiceLimits((prev) => {
      if (prev[slug]) return prev; // already configured
      return { ...prev, [slug]: { service: slug } };
    });
    setCustomServiceDraft("");
  }

  function removePerService(service: string) {
    const slug = service.toLowerCase();
    setPerServiceLimits((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }

  async function save() {
    setSaveState("saving");
    setSaveError(null);

    // Strip empty entries: an entry with no caps and not blocked is a no-op,
    // and persisting it would just clutter the DB.
    const perServiceArray: PerServiceLimit[] = Object.values(perServiceLimits).filter(
      (entry) => {
        const hasMonthly =
          entry.monthly_cap_usd !== undefined &&
          entry.monthly_cap_usd !== null &&
          entry.monthly_cap_usd > 0;
        const hasPerTx =
          entry.per_tx_cap_usd !== undefined &&
          entry.per_tx_cap_usd !== null &&
          entry.per_tx_cap_usd > 0;
        return hasMonthly || hasPerTx || entry.blocked === true;
      }
    );

    const payload: RulesPayload = {
      max_auto_charge_usd: Math.max(0, parseFloat(perTx) || 0),
      monthly_budget: Math.max(0, parseFloat(monthlyBudget) || 0),
      // We always send `null` for allowed_services for now: the MCC lock is
      // enforced at the card level (Stripe Issuing), not via this rule.
      allowed_services: null,
      blocked_services: blockedMerchants.length > 0 ? blockedMerchants : null,
      per_service_limits: perServiceArray,
    };

    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 4000);
    }
  }

  // ─── derived display values ─────────────────────────────────────────────
  const perTxDisplay = useMemo(() => {
    const n = parseFloat(perTx);
    if (!Number.isFinite(n) || n <= 0) return "any amount (confirm every charge)";
    return `${CURRENCY_SYMBOL}${n.toFixed(0)} per transaction`;
  }, [perTx]);

  const monthlyDisplay = useMemo(() => {
    const n = parseFloat(monthlyBudget);
    if (!Number.isFinite(n) || n <= 0) return "no monthly cap";
    return `${CURRENCY_SYMBOL}${n.toFixed(0)} per month`;
  }, [monthlyBudget]);

  return (
    <main>
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4">
        <h1 className="text-lg font-semibold text-[#0a1220]">Rules</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Set your envelope. Your agent operates inside it — no prompts, no interruptions.
        </p>
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-2xl space-y-5">
        {loadError && (
          <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600">
            Failed to load rules: {loadError}
          </div>
        )}

        {/* ── summary recap ───────────────────────────────────────────────── */}
        <div className="rounded-xl border border-[#00e5b4]/30 bg-gradient-to-br from-[#00e5b4]/10 to-white p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#00876a] mb-2">
            Current limits
          </p>
          <p className="text-sm leading-relaxed text-[#070d18]">
            Your agent can spend up to{" "}
            <span className="font-semibold">{perTxDisplay}</span>, capped at{" "}
            <span className="font-semibold">{monthlyDisplay}</span>, on{" "}
            <span className="font-semibold">dev-tool merchants only</span>
            {blockedMerchants.length > 0 && (
              <>
                {" "}
                — with{" "}
                <span className="font-semibold">{blockedMerchants.length}</span>{" "}
                merchant{blockedMerchants.length === 1 ? "" : "s"} explicitly blocked
              </>
            )}
            .
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-100 p-6 space-y-6">
          {/* ── Maximum per transaction ────────────────────────────────── */}
          <section>
            <label htmlFor={perTxId} className="block text-sm font-semibold text-[#070d18] mb-1">
              Maximum per transaction
            </label>
            <p className="text-xs text-slate-500 mb-3">
              Charges at or below this amount are processed instantly. Set to 0 to confirm every charge.
            </p>

            <div className="flex flex-wrap gap-2 mb-3">
              {PER_TX_PRESETS.map((amt) => {
                const active = parseFloat(perTx) === amt;
                return (
                  <button
                    key={amt}
                    type="button"
                    disabled={loading}
                    onClick={() => setPerTx(String(amt))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      active
                        ? "bg-[#00e5b4] border-[#00e5b4] text-[#070d18]"
                        : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {CURRENCY_SYMBOL}
                    {amt}
                  </button>
                );
              })}
            </div>

            <div className="relative max-w-xs">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                {CURRENCY_SYMBOL}
              </span>
              <input
                id={perTxId}
                type="number"
                min="0"
                disabled={loading}
                value={perTx}
                onChange={(e) => setPerTx(e.target.value)}
                placeholder="Custom amount"
                className="w-full border border-slate-200 rounded-lg pl-6 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00e5b4] focus:border-[#00e5b4] disabled:bg-slate-50 disabled:text-slate-400"
              />
            </div>
          </section>

          {/* ── Monthly budget ─────────────────────────────────────────── */}
          <section className="border-t border-slate-50 pt-5">
            <label htmlFor={monthlyId} className="block text-sm font-semibold text-[#070d18] mb-1">
              Monthly budget
            </label>
            <p className="text-xs text-slate-500 mb-3">
              Your agent will stop making payments once this limit is reached in a calendar month.
            </p>

            <div className="flex flex-wrap gap-2 mb-3">
              {MONTHLY_PRESETS.map((amt) => {
                const active = parseFloat(monthlyBudget) === amt;
                return (
                  <button
                    key={amt}
                    type="button"
                    disabled={loading}
                    onClick={() => setMonthlyBudget(String(amt))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      active
                        ? "bg-[#00e5b4] border-[#00e5b4] text-[#070d18]"
                        : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {CURRENCY_SYMBOL}
                    {amt}
                  </button>
                );
              })}
            </div>

            <div className="relative max-w-xs">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                {CURRENCY_SYMBOL}
              </span>
              <input
                id={monthlyId}
                type="number"
                min="0"
                disabled={loading}
                value={monthlyBudget}
                onChange={(e) => setMonthlyBudget(e.target.value)}
                placeholder="Custom amount"
                className="w-full border border-slate-200 rounded-lg pl-6 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00e5b4] focus:border-[#00e5b4] disabled:bg-slate-50 disabled:text-slate-400"
              />
            </div>
          </section>

          {/* ── Per-service limits ─────────────────────────────────────── */}
          <section className="border-t border-slate-50 pt-5">
            <label className="block text-sm font-semibold text-[#070d18] mb-1">
              Per-service limits
            </label>
            <p className="text-xs text-slate-500 mb-3">
              Layer tighter limits on top of the global caps for specific services
              (e.g. {CURRENCY_SYMBOL}20/month on Vercel, {CURRENCY_SYMBOL}200/month on Modal,
              blocked on Netflix). Leave blank to inherit the global rules.
            </p>

            <div className="rounded-lg border border-slate-100 divide-y divide-slate-100">
              {/* Render every common service plus any custom service the
                  user has added. Custom entries that are not in the curated
                  list get a placeholder label derived from their slug. */}
              {(() => {
                const customSlugs = Object.keys(perServiceLimits).filter(
                  (slug) => !COMMON_SERVICES.some((s) => s.slug === slug)
                );
                const rows = [
                  ...COMMON_SERVICES.map((s) => ({ ...s, isCustom: false })),
                  ...customSlugs.map((slug) => ({
                    slug,
                    label: slug.charAt(0).toUpperCase() + slug.slice(1),
                    icon: "•",
                    isCustom: true,
                  })),
                ];
                return rows.map((row) => {
                  const entry = perServiceLimits[row.slug];
                  const monthly =
                    entry?.monthly_cap_usd !== undefined &&
                    entry?.monthly_cap_usd !== null
                      ? String(entry.monthly_cap_usd)
                      : "";
                  const perTxCap =
                    entry?.per_tx_cap_usd !== undefined &&
                    entry?.per_tx_cap_usd !== null
                      ? String(entry.per_tx_cap_usd)
                      : "";
                  const blocked = entry?.blocked === true;
                  return (
                    <div
                      key={row.slug}
                      className="flex flex-col sm:flex-row sm:items-center gap-3 px-3 py-3"
                    >
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <span aria-hidden="true" className="text-base">
                          {row.icon}
                        </span>
                        <span className="text-sm font-medium text-[#070d18]">
                          {row.label}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-2 flex-1">
                        <div className="relative">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                            {CURRENCY_SYMBOL}
                          </span>
                          <input
                            type="number"
                            min="0"
                            disabled={loading || blocked}
                            value={monthly}
                            onChange={(e) =>
                              setPerServiceField(row.slug, "monthly_cap_usd", e.target.value)
                            }
                            placeholder="Monthly cap"
                            aria-label={`${row.label} monthly cap`}
                            className="w-32 border border-slate-200 rounded-lg pl-5 pr-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#00e5b4] focus:border-[#00e5b4] disabled:bg-slate-50 disabled:text-slate-400"
                          />
                        </div>

                        <div className="relative">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                            {CURRENCY_SYMBOL}
                          </span>
                          <input
                            type="number"
                            min="0"
                            disabled={loading || blocked}
                            value={perTxCap}
                            onChange={(e) =>
                              setPerServiceField(row.slug, "per_tx_cap_usd", e.target.value)
                            }
                            placeholder="Per-tx cap"
                            aria-label={`${row.label} per-transaction cap`}
                            className="w-32 border border-slate-200 rounded-lg pl-5 pr-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#00e5b4] focus:border-[#00e5b4] disabled:bg-slate-50 disabled:text-slate-400"
                          />
                        </div>

                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => togglePerServiceBlocked(row.slug)}
                          aria-pressed={blocked}
                          className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            blocked
                              ? "bg-red-50 border-red-200 text-red-700"
                              : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                          }`}
                        >
                          {blocked ? "Blocked" : "Block"}
                        </button>

                        {row.isCustom && (
                          <button
                            type="button"
                            onClick={() => removePerService(row.slug)}
                            aria-label={`Remove ${row.label}`}
                            className="px-2 py-1.5 rounded-lg text-xs text-slate-400 hover:text-red-500 transition-colors"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Add custom service (anything not in the curated list above). */}
            <div className="flex gap-2 mt-3">
              <input
                type="text"
                disabled={loading}
                value={customServiceDraft}
                onChange={(e) => setCustomServiceDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomPerService();
                  }
                }}
                placeholder="Add custom service (e.g. heroku)"
                aria-label="Add custom service"
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00e5b4] focus:border-[#00e5b4] disabled:bg-slate-50 disabled:text-slate-400"
              />
              <button
                type="button"
                disabled={loading || customServiceDraft.trim() === ""}
                onClick={addCustomPerService}
                className="px-3 py-2 rounded-lg text-sm font-medium border border-slate-200 text-[#070d18] hover:border-[#00e5b4] hover:text-[#00876a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
          </section>

          {/* ── Merchant category locks ────────────────────────────────── */}
          <section className="border-t border-slate-50 pt-5">
            <label className="block text-sm font-semibold text-[#070d18] mb-1">
              Merchant category locks
            </label>
            <p className="text-xs text-slate-400 mb-3">
              Your Spendex card is locked to dev-tool merchants by default. These categories are allowed:
            </p>

            <div className="rounded-lg border border-slate-100 bg-slate-50/60 divide-y divide-slate-100">
              {MCC_CATEGORIES.map((cat) => (
                <div
                  key={cat.id}
                  className="flex items-start gap-3 px-4 py-3"
                >
                  <span
                    className="mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#00e5b4]/15"
                    aria-hidden="true"
                  >
                    <svg
                      className="h-2.5 w-2.5 text-[#00876a]"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        d="M2.5 6.5l2.5 2.5 4.5-5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[#070d18]">{cat.label}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{cat.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
              These categories are enforced at the card level by Stripe Issuing — a compromised card
              cannot be used at restaurants, retail, or other unrelated merchants. To restrict
              further, contact{" "}
              <a
                href="mailto:support@spendexai.com"
                className="underline underline-offset-2 hover:text-[#070d18] transition-colors"
              >
                support
              </a>
              .
            </p>
          </section>

          {/* ── Merchant exclusions ────────────────────────────────────── */}
          <section className="border-t border-slate-50 pt-5">
            <label htmlFor={merchantId} className="block text-sm font-semibold text-[#070d18] mb-1">
              Merchant exclusions
            </label>
            <p className="text-xs text-slate-500 mb-3">
              Block specific merchants even when they fall inside the allowed categories. Match is
              case-insensitive and uses substring matching against the merchant name.
            </p>

            <div className="flex gap-2 mb-3">
              <input
                id={merchantId}
                type="text"
                disabled={loading}
                value={merchantDraft}
                onChange={(e) => setMerchantDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addMerchant();
                  }
                }}
                placeholder="e.g. heroku, openai"
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00e5b4] focus:border-[#00e5b4] disabled:bg-slate-50 disabled:text-slate-400"
              />
              <button
                type="button"
                disabled={loading || merchantDraft.trim() === ""}
                onClick={addMerchant}
                className="px-4 py-2.5 rounded-lg text-sm font-medium border border-slate-200 text-[#070d18] hover:border-[#00e5b4] hover:text-[#00876a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>

            {blockedMerchants.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {blockedMerchants.map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-100"
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => removeMerchant(m)}
                      className="text-red-500 hover:text-red-700 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1"
                      aria-label={`Remove ${m}`}
                    >
                      <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400 italic">
                No merchants blocked. All dev-tool merchants are reachable.
              </p>
            )}
          </section>

          {/* ── Emergency stop ─────────────────────────────────────────── */}
          <section className="border-t border-slate-50 pt-5">
            <label className="block text-sm font-semibold text-[#070d18] mb-3">
              Emergency stop
            </label>
            <div className="flex items-start gap-3 rounded-lg border border-amber-100 bg-amber-50 p-4">
              <svg
                className="w-4 h-4 text-amber-500 mt-0.5 shrink-0"
                fill="none"
                viewBox="0 0 16 16"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path d="M8 2L14 13H2L8 2z" strokeLinejoin="round" />
                <line x1="8" y1="7" x2="8" y2="10" strokeLinecap="round" />
                <circle cx="8" cy="12" r="0.5" fill="currentColor" />
              </svg>
              <div>
                <p className="text-sm font-medium text-amber-800">
                  Halt all agent payments
                </p>
                <p className="text-xs text-amber-600 mt-0.5 leading-relaxed">
                  To activate an emergency stop, set{" "}
                  <code className="font-mono bg-amber-100 px-1 rounded">EMERGENCY_STOP=true</code>{" "}
                  in your server environment. All payment attempts will be rejected immediately without a
                  restart.{" "}
                  <a
                    href="mailto:support@spendexai.com"
                    className="underline underline-offset-2 hover:text-amber-900 transition-colors"
                  >
                    Contact support
                  </a>{" "}
                  if you need help.
                </p>
              </div>
            </div>
          </section>

          {/* ── Save button + feedback ─────────────────────────────────── */}
          <div className="pt-2 flex items-center gap-4">
            <button
              type="button"
              onClick={save}
              disabled={loading || saveState === "saving"}
              className={`font-semibold text-sm px-5 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                saveState === "saved"
                  ? "bg-[#00e5b4]/15 text-[#00a882]"
                  : saveState === "error"
                  ? "bg-red-50 text-red-600 border border-red-200"
                  : "bg-[#00e5b4] hover:bg-[#00c49a] text-[#070d18]"
              }`}
            >
              {saveState === "saving"
                ? "Saving…"
                : saveState === "saved"
                ? "Saved"
                : saveState === "error"
                ? "Save failed"
                : "Save rules"}
            </button>

            <span className="sr-only" aria-live="polite">
              {saveState === "saving"
                ? "Saving rules"
                : saveState === "saved"
                ? "Rules saved"
                : saveState === "error"
                ? `Save failed${saveError ? `: ${saveError}` : ""}`
                : ""}
            </span>

            {saveState === "error" && saveError && (
              <p className="text-xs text-red-600">{saveError}</p>
            )}

            {loading && (
              <p className="text-xs text-slate-500">Loading current rules…</p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
