"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// ─── types ───────────────────────────────────────────────────────────────────

export interface VirtualCardSummary {
  /** Last four digits of the PAN. Safe to render server-side. */
  last4: string;
  /** Stripe card brand string, e.g. "Visa", "Mastercard". */
  brand: string;
  /** Stripe Issuing card status. 'active' or 'inactive'. */
  status: "active" | "inactive";
}

interface Props {
  card: VirtualCardSummary | null;
  // Kept for backwards compatibility with the page component, even though
  // the new layout no longer displays a "used services" grid.
  usedServices: string[];
}

interface RevealedCard {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  brand: string;
  last4: string;
}

interface Integration {
  name: string;
  description: string;
  status: "connected" | "coming_soon" | "fallback";
}

// ─── integrations catalog ────────────────────────────────────────────────────

const INTEGRATIONS: Integration[] = [
  {
    name: "Vercel",
    description: "Native API integration. Coming v2.",
    status: "coming_soon",
  },
  {
    name: "Modal",
    description: "Native API integration. Coming v2.",
    status: "coming_soon",
  },
  {
    name: "Anthropic Console",
    description: "Native API integration. Coming v2.",
    status: "coming_soon",
  },
  {
    name: "Other services",
    description: "Universal fallback via virtual card. Works today.",
    status: "fallback",
  },
];

// ─── component ───────────────────────────────────────────────────────────────

export default function ServicesClient({ card: initialCard }: Props) {
  // We mirror the server-provided card in local state so the freeze /
  // unfreeze flow can flip the status badge without a full page reload.
  const [card, setCard] = useState<VirtualCardSummary | null>(initialCard);

  return (
    <main>
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Control
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0a1220]">
            Virtual card
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            Card status, fallback payment details, and service integration coverage.
          </p>
        </div>
      </header>

      <div className="max-w-6xl space-y-10 px-4 py-7 sm:px-8">
        {/* Card showcase */}
        <section>
          <p className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase mb-3">
            Your virtual card
          </p>
          {card ? (
            <CardShowcase
              last4={card.last4}
              brand={card.brand}
              status={card.status}
              onStatusChange={(next) =>
                setCard((prev) => (prev ? { ...prev, status: next } : prev))
              }
            />
          ) : (
            <NoCardState />
          )}
        </section>

        {/* How your agent uses it */}
        <section>
          <div className="mb-4">
            <p className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase">
              Authorization path
            </p>
            <p className="text-sm text-slate-500 mt-1">
              Each charge is checked against limits, consent state, and merchant data.
            </p>
          </div>
          <AgentFlowDiagram />
        </section>

        {/* Active integrations */}
        <section>
          <div className="mb-4">
            <p className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase">
              Active integrations
            </p>
            <p className="text-sm text-slate-500 mt-1">
              Native integrations avoid card exposure where supported. The
              virtual card remains the controlled fallback for every other service.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {INTEGRATIONS.map((integration) => (
              <IntegrationCard
                key={integration.name}
                integration={integration}
              />
            ))}
          </div>
        </section>

        {/* When to use the card details directly */}
        {card && <CardDetailsAdvanced />}
      </div>
    </main>
  );
}

// ─── agent flow diagram ──────────────────────────────────────────────────────

function AgentFlowDiagram() {
  const steps = [
    {
      title: "A service needs payment",
      detail: "Deploys, model calls, GPU jobs, and subscriptions create charge requests.",
    },
    {
      title: "Calls pay_for_service() via MCP",
      detail: "The agent asks Spendex to authorize the spend on your behalf.",
    },
    {
      title: "Spendex checks your rules in <2s",
      detail: "Budget caps, allowed services, per-call limits — all enforced.",
    },
    {
      title: "Approved or declined",
      detail:
        "On approve, payment completes. On decline, the agent asks you or finds another path.",
    },
  ];

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-6 sm:p-8">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 md:gap-2">
        {steps.map((step, idx) => (
          <div key={step.title} className="relative flex md:block">
            <FlowStep index={idx + 1} step={step} />
            {idx < steps.length - 1 && (
              <FlowArrow />
            )}
          </div>
        ))}
      </div>

      <div className="mt-7 pt-6 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-xs text-slate-500">
          Configure budgets and allowed services on the{" "}
          <Link
            href="/dashboard/rules"
            className="font-medium text-[#00a882] hover:text-[#00e5b4]"
          >
            Rules
          </Link>{" "}
          page. Watch live charges on{" "}
          <Link
            href="/dashboard/transactions"
            className="font-medium text-[#00a882] hover:text-[#00e5b4]"
          >
            Transactions
          </Link>
          .
        </p>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#00a882] bg-[#00e5b4]/15 px-2.5 py-1 rounded-full self-start sm:self-auto">
          <span className="w-1.5 h-1.5 rounded-full bg-[#00a882]" />
          Average decision: under 2 seconds
        </span>
      </div>
    </div>
  );
}

function FlowStep({
  index,
  step,
}: {
  index: number;
  step: { title: string; detail: string };
}) {
  return (
    <div className="flex-1 bg-[#070d18] text-white rounded-xl p-4 min-h-[120px]">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-5 h-5 rounded-full bg-[#00e5b4] text-[#070d18] text-[10px] font-bold flex items-center justify-center">
          {index}
        </span>
        <p className="text-[10px] tracking-widest uppercase text-white/55">
          Step {index}
        </p>
      </div>
      <p className="text-sm font-semibold leading-snug">{step.title}</p>
      <p className="text-[11px] text-white/60 leading-relaxed mt-2">
        {step.detail}
      </p>
    </div>
  );
}

function FlowArrow() {
  return (
    <>
      {/* Desktop: arrow points right, sits inline between cards */}
      <div
        className="hidden md:flex absolute top-1/2 -right-2 -translate-y-1/2 items-center justify-center text-[#00e5b4] text-lg z-10 bg-white rounded-full w-5 h-5"
        aria-hidden="true"
      >
        →
      </div>
      {/* Mobile: arrow points down, between stacked cards */}
      <div
        className="md:hidden flex items-center justify-center text-[#00e5b4] text-xl py-1"
        aria-hidden="true"
      >
        ↓
      </div>
    </>
  );
}

// ─── integration card ────────────────────────────────────────────────────────

function IntegrationCard({ integration }: { integration: Integration }) {
  const badge = (() => {
    switch (integration.status) {
      case "connected":
        return {
          label: "Connected",
          className: "bg-[#00e5b4]/15 text-[#00a882]",
        };
      case "fallback":
        return {
          label: "Works today",
          className: "bg-[#00e5b4]/15 text-[#00a882]",
        };
      case "coming_soon":
      default:
        return {
          label: "Coming soon",
          className: "bg-slate-100 text-slate-500",
        };
    }
  })();

  return (
    <div className="bg-white border border-slate-100 rounded-xl p-4 flex items-start justify-between gap-3 hover:border-slate-200 transition-colors">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-[#0a1220]">
          {integration.name}
        </h3>
        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
          {integration.description}
        </p>
      </div>
      <span
        className={`text-[10px] font-semibold px-2 py-0.5 rounded uppercase tracking-wider shrink-0 ${badge.className}`}
      >
        {badge.label}
      </span>
    </div>
  );
}

// ─── card details advanced (collapsible reveal) ──────────────────────────────

function CardDetailsAdvanced() {
  const [open, setOpen] = useState(false);

  return (
    <section>
      <div className="bg-white border border-slate-100 rounded-2xl p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#0a1220]">
              When to use the card details directly
            </p>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed max-w-2xl">
              Most of the time, you don&rsquo;t need to see your card details
              — your agent fetches them when needed via MCP. If you want to
              add the card to a service manually (e.g. a service your agent
              doesn&rsquo;t know how to pay), reveal the details below.
            </p>
          </div>
          {!open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-xs font-semibold text-white bg-[#070d18] hover:bg-[#0f1c30] rounded-lg px-3 py-2 transition-colors shrink-0"
            >
              Reveal card details
            </button>
          )}
        </div>

        {open && (
          <div className="mt-5 pt-5 border-t border-slate-100">
            <RevealPanel onClose={() => setOpen(false)} />
          </div>
        )}
      </div>
    </section>
  );
}

// ─── reveal panel ────────────────────────────────────────────────────────────

const REVEAL_TTL_MS = 60_000;

function RevealPanel({ onClose }: { onClose: () => void }) {
  const [revealed, setRevealed] = useState<RevealedCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  const hide = useCallback(() => {
    clearTimers();
    setRevealed(null);
    setSecondsLeft(0);
  }, [clearTimers]);

  const reveal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/services/card-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = (await res.json()) as RevealedCard | { error: string };
      if (!res.ok || "error" in json) {
        const message =
          "error" in json ? json.error : "Failed to reveal card details";
        setError(message);
        return;
      }
      setRevealed(json);
      setSecondsLeft(Math.floor(REVEAL_TTL_MS / 1000));
      timeoutRef.current = setTimeout(() => {
        hide();
      }, REVEAL_TTL_MS);
      intervalRef.current = setInterval(() => {
        setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
      }, 1000);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }, [hide]);

  // Auto-fetch on mount so the user sees the details immediately when
  // they expand the panel.
  useEffect(() => {
    void reveal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && !revealed && !error) {
    return (
      <p className="text-xs text-slate-500">Revealing card details…</p>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-red-500">{error}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={reveal}
            className="text-xs font-semibold text-white bg-[#070d18] hover:bg-[#0f1c30] rounded-lg px-3 py-2 transition-colors"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => {
              hide();
              onClose();
            }}
            className="text-xs font-semibold text-[#0a1220] bg-white border border-slate-200 hover:border-slate-300 rounded-lg px-3 py-2 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  if (!revealed) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <DetailField label="Card number" value={formatPan(revealed.number)} />
        <DetailField
          label="Expiry"
          value={`${pad2(revealed.expMonth)}/${String(revealed.expYear).slice(
            -2
          )}`}
        />
        <DetailField label="CVC" value={revealed.cvc} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <CopyButton label="Copy number" value={revealed.number} />
        <CopyButton
          label="Copy expiry"
          value={`${pad2(revealed.expMonth)}/${String(revealed.expYear).slice(
            -2
          )}`}
        />
        <CopyButton label="Copy CVC" value={revealed.cvc} />
        <button
          type="button"
          onClick={() => {
            hide();
            onClose();
          }}
          className="text-xs font-semibold text-[#0a1220] bg-white border border-slate-200 hover:border-slate-300 rounded-lg px-3 py-2 transition-colors"
        >
          Hide details
        </button>
      </div>

      <p className="text-[11px] text-slate-400">
        Auto-hides in {secondsLeft}s
      </p>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#070d18] text-white rounded-lg p-3">
      <p className="text-[10px] tracking-widest uppercase text-white/55">
        {label}
      </p>
      <p className="font-mono text-sm tracking-wider mt-1.5">{value}</p>
    </div>
  );
}

// ─── card showcase ───────────────────────────────────────────────────────────

interface CardShowcaseProps {
  last4: string;
  brand: string;
  status: "active" | "inactive";
  onStatusChange: (next: "active" | "inactive") => void;
}

function CardShowcase(props: CardShowcaseProps) {
  const { last4, brand, status } = props;
  const frozen = status === "inactive";
  return (
    <div className="flex flex-col lg:flex-row items-start gap-6">
      {/* The card itself — visual only. Details live in the advanced section. */}
      <div
        className="relative w-full max-w-[400px] aspect-[1.586/1] rounded-2xl p-6 text-white overflow-hidden shrink-0"
        style={{
          background: frozen
            ? "linear-gradient(135deg, #1a1f2c 0%, #232938 55%, #2c3344 100%)"
            : "linear-gradient(135deg, #070d18 0%, #0a1220 55%, #0e1a30 100%)",
          boxShadow:
            "0 20px 40px -12px rgba(7,13,24,0.45), 0 1px 0 rgba(255,255,255,0.04) inset",
          filter: frozen ? "saturate(0.5)" : undefined,
        }}
      >
        {frozen && (
          <span className="absolute top-3 right-3 z-20 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest bg-red-500/90 text-white px-2 py-0.5 rounded">
            Frozen
          </span>
        )}
        {/* Decorative glow */}
        <div
          aria-hidden="true"
          className="absolute -top-16 -right-16 w-48 h-48 rounded-full opacity-30 blur-3xl pointer-events-none"
          style={{ background: "#00e5b4" }}
        />

        {/* Header row */}
        <div className="flex items-start justify-between relative">
          <div>
            <p className="text-[10px] tracking-[0.2em] text-white/55 uppercase">
              Spendex Pay
            </p>
            <p className="text-[10px] tracking-wider text-white/40 mt-0.5">
              Virtual card
            </p>
          </div>
          <div
            className="w-7 h-5 rounded-sm"
            style={{
              background:
                "linear-gradient(135deg, #d4af37 0%, #b9892b 50%, #d4af37 100%)",
            }}
            aria-hidden="true"
          />
        </div>

        {/* Card number — always masked at this layer; reveal happens below. */}
        <div className="mt-9 relative">
          <div className="font-mono text-[19px] sm:text-[20px] tracking-[0.18em] opacity-90">
            {`•••• •••• •••• ${last4}`}
          </div>
        </div>

        {/* Expiry + CVC + brand */}
        <div className="absolute bottom-6 left-6 right-6 flex items-end justify-between">
          <div className="flex gap-6">
            <div>
              <p className="text-[9px] tracking-widest uppercase text-white/45 mb-1">
                Expires
              </p>
              <p className="font-mono text-sm tracking-wider">••/••</p>
            </div>
            <div>
              <p className="text-[9px] tracking-widest uppercase text-white/45 mb-1">
                CVC
              </p>
              <p className="font-mono text-sm tracking-wider">•••</p>
            </div>
          </div>
          <div className="text-right">
            <BrandMark brand={brand} />
          </div>
        </div>
      </div>

      {/* Explanatory copy */}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-slate-500 leading-relaxed">
          This is your reusable Spendex card. Your AI agent reaches it through
          the{" "}
          <code className="font-mono text-[11px] bg-slate-100 text-[#0a1220] px-1.5 py-0.5 rounded">
            pay_for_service
          </code>{" "}
          MCP tool — no copy-paste required. Charges appear on your{" "}
          <Link
            href="/dashboard/transactions"
            className="font-medium text-[#00a882] hover:text-[#00e5b4]"
          >
            Transactions
          </Link>{" "}
          page in real time, gated by the limits you set under{" "}
          <Link
            href="/dashboard/rules"
            className="font-medium text-[#00a882] hover:text-[#00e5b4]"
          >
            Rules
          </Link>
          .
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {frozen ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-red-600 bg-red-50 border border-red-100 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
              Card frozen
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#00a882] bg-[#00e5b4]/15 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00a882]" />
              Card active
            </span>
          )}
          <span className="text-[11px] text-slate-400">
            {brand} ending in {last4}
          </span>
        </div>

        <div className="mt-4">
          <FreezeControl status={status} onStatusChange={props.onStatusChange} />
        </div>
      </div>
    </div>
  );
}

// ─── freeze control ──────────────────────────────────────────────────────────
//
// Inline freeze / unfreeze trigger. Renders the button in the wallet
// panel and a confirmation modal before sending the API call.

interface FreezeControlProps {
  status: "active" | "inactive";
  onStatusChange: (next: "active" | "inactive") => void;
}

function FreezeControl({ status, onStatusChange }: FreezeControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const frozen = status === "inactive";

  async function applyChange(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/wallet/freeze", {
        method: frozen ? "DELETE" : "POST",
      });
      const json = (await res.json()) as {
        status?: "active" | "inactive";
        error?: string;
      };
      if (!res.ok || !json.status) {
        setError(json.error ?? "Failed to update card status");
        return;
      }
      onStatusChange(json.status);
      setConfirming(false);
    } catch {
      setError("Network error — please try again");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
        className={
          frozen
            ? "text-xs font-semibold text-[#0a1220] bg-white border border-slate-200 hover:border-slate-300 rounded-lg px-3 py-2 transition-colors"
            : "text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 border border-red-100 hover:border-red-200 rounded-lg px-3 py-2 transition-colors"
        }
      >
        {frozen ? "Unfreeze card" : "🚨 Freeze card"}
      </button>

      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            <p className="text-sm font-semibold text-[#0a1220]">
              {frozen ? "Unfreeze your card?" : "Freeze your card?"}
            </p>
            <p className="text-xs text-slate-500 mt-2 leading-relaxed">
              {frozen
                ? "Your card will be active again. New transactions will be authorised against your rules."
                : "Cette action décline toutes les nouvelles tx jusqu'à unfreeze. Continuer ?"}
            </p>
            {error && <p className="text-xs text-red-500 mt-3">{error}</p>}
            <div className="mt-5 flex items-center gap-2 justify-end">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setConfirming(false)}
                className="text-xs font-medium text-slate-600 hover:text-slate-800 border border-slate-200 hover:border-slate-300 rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={applyChange}
                className={
                  frozen
                    ? "text-xs font-semibold text-[#070d18] bg-[#00e5b4] hover:bg-[#00c49a] rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
                    : "text-xs font-semibold text-white bg-red-500 hover:bg-red-600 rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
                }
              >
                {submitting
                  ? "Working…"
                  : frozen
                    ? "Yes, unfreeze"
                    : "Yes, freeze card"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function BrandMark({ brand }: { brand: string }) {
  const normalized = brand.toLowerCase();
  if (normalized.includes("master")) {
    return (
      <div
        className="flex items-center gap-[2px]"
        title="Mastercard"
        aria-label="Mastercard"
      >
        <span className="w-5 h-5 rounded-full bg-[#eb001b] block opacity-90" />
        <span className="w-5 h-5 rounded-full bg-[#f79e1b] block opacity-90 -ml-2 mix-blend-screen" />
      </div>
    );
  }
  // Default to Visa-style wordmark.
  return (
    <span
      className="font-extrabold italic tracking-tight text-base"
      style={{ color: "#ffffff", letterSpacing: "-0.04em" }}
      title="Visa"
      aria-label="Visa"
    >
      VISA
    </span>
  );
}

// ─── copy button ─────────────────────────────────────────────────────────────

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked by the browser (e.g. insecure context).
      // Silently fall back — user can still read the number on screen.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="text-xs font-medium text-slate-700 hover:text-[#0a1220] border border-slate-200 hover:border-slate-300 bg-white rounded-lg px-2.5 py-2 transition-colors"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

// ─── no-card empty state ─────────────────────────────────────────────────────

function NoCardState() {
  return (
    <div className="bg-white border border-dashed border-slate-200 rounded-2xl p-8 text-center">
      <p className="text-sm font-medium text-[#0a1220]">
        No virtual card yet
      </p>
      <p className="text-xs text-slate-500 mt-1.5 max-w-md mx-auto">
        Connect a card on the{" "}
        <Link
          href="/dashboard/payments"
          className="text-[#00a882] hover:text-[#00e5b4] font-medium"
        >
          Funding source
        </Link>{" "}
        page to provision your wallet. Once it&rsquo;s active, your agent can
        pay autonomously through the{" "}
        <code className="font-mono text-[11px] bg-slate-100 text-[#0a1220] px-1.5 py-0.5 rounded">
          pay_for_service
        </code>{" "}
        MCP tool.
      </p>
    </div>
  );
}

// ─── formatters ──────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatPan(pan: string): string {
  // Render the 16-digit PAN as four groups of four. Falls back to the raw
  // value if the input is shorter or longer than expected.
  const digits = pan.replace(/\s+/g, "");
  if (digits.length !== 16) return pan;
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(
    8,
    12
  )} ${digits.slice(12, 16)}`;
}
