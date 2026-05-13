"use client";

import { useState, useEffect, useCallback } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");

interface SavedPaymentMethod {
  id: string;
  type: string;
  brand: string;
  last4: string;
  expMonth?: number;
  expYear?: number;
}

// ─── card form (inside Elements provider) ────────────────────────────────────

function CardForm({ onSuccess, onCancel }: { onSuccess: (pm: SavedPaymentMethod) => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;

    setLoading(true);
    setError(null);

    const cardElement = elements.getElement(CardElement);
    if (!cardElement) return;

    // Confirm the SetupIntent with the card details
    const { error: confirmError, setupIntent } = await stripe.confirmCardSetup(
      (window as unknown as Record<string, string>).__spendex_client_secret,
      { payment_method: { card: cardElement } }
    );

    if (confirmError) {
      setError(confirmError.message ?? "Card setup failed");
      setLoading(false);
      return;
    }

    const paymentMethodId = typeof setupIntent?.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id;

    if (!paymentMethodId) {
      setError("No payment method ID returned");
      setLoading(false);
      return;
    }

    // Tell the server to mark this as the default payment method
    const res = await fetch("/api/payments/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethodId }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to save payment method");
      setLoading(false);
      return;
    }

    onSuccess(data.paymentMethod);
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-2">Card details</label>
        <div className="border border-slate-200 rounded-lg px-4 py-3 focus-within:border-[#6D5BFF] transition-colors">
          <CardElement
            options={{
              style: {
                base: {
                  fontSize: "14px",
                  color: "#0D0F14",
                  fontFamily: "'Inter', system-ui, sans-serif",
                  "::placeholder": { color: "#94a3b8" },
                },
                invalid: { color: "#ef4444" },
              },
            }}
          />
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium text-sm py-2.5 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading || !stripe}
          className="flex-1 bg-[#6D5BFF] hover:bg-[#5b48ff] disabled:opacity-40 disabled:cursor-not-allowed text-[#0D0F14] font-semibold text-sm py-2.5 rounded-lg transition-colors"
        >
          {loading ? "Saving…" : "Save card"}
        </button>
      </div>

      <p className="text-center text-xs text-slate-400">
        Secured by Stripe — your card number is never sent to our servers
      </p>
    </form>
  );
}

// ─── modal ────────────────────────────────────────────────────────────────────

function AddCardModal({
  clientSecret,
  onSuccess,
  onClose,
}: {
  clientSecret: string;
  onSuccess: (pm: SavedPaymentMethod) => void;
  onClose: () => void;
}) {
  // Store client secret where CardForm can reach it without prop drilling through Elements
  useEffect(() => {
    (window as unknown as Record<string, string>).__spendex_client_secret = clientSecret;
  }, [clientSecret]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-card-title"
      className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center sm:p-4 bg-black/40 sm:backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white sm:rounded-2xl shadow-xl w-full sm:max-w-md flex flex-col h-full sm:h-auto sm:max-h-[90vh]">
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 sm:py-5 border-b border-slate-100">
          <h2 id="add-card-title" className="text-base font-semibold text-[#0D0F14]">Add credit or debit card</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close add card dialog"
            className="text-slate-500 hover:text-slate-700 -mr-1 p-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6D5BFF]"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="p-5 sm:p-6 flex-1 overflow-y-auto">
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <CardForm onSuccess={onSuccess} onCancel={onClose} />
          </Elements>
        </div>
      </div>
    </div>
  );
}

// ─── card brand icon ──────────────────────────────────────────────────────────

function CardBrandIcon({ brand }: { brand: string }) {
  const colors: Record<string, string> = {
    visa: "#1a1f71",
    mastercard: "#eb001b",
    amex: "#2e77bc",
    discover: "#f76f20",
  };
  const color = colors[brand.toLowerCase()] ?? "#64748b";
  return (
    <div className="w-10 h-7 rounded border border-slate-100 bg-slate-50 flex items-center justify-center shrink-0">
      <span className="text-[10px] font-bold uppercase tracking-tight" style={{ color }}>{brand.slice(0, 4)}</span>
    </div>
  );
}

// ─── main export ──────────────────────────────────────────────────────────────

export default function PaymentsClient({ initialMethod }: { initialMethod: SavedPaymentMethod | null }) {
  const [paymentMethod, setPaymentMethod] = useState<SavedPaymentMethod | null>(initialMethod);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loadingSetup, setLoadingSetup] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const openAddCard = useCallback(async () => {
    setLoadingSetup(true);
    setSetupError(null);
    try {
      const res = await fetch("/api/payments/setup-intent", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create setup intent");
      setClientSecret(data.clientSecret);
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoadingSetup(false);
    }
  }, []);

  async function handleRemove() {
    if (!paymentMethod) return;
    setRemoving(true);
    await fetch("/api/payments", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethodId: paymentMethod.id }),
    });
    setPaymentMethod(null);
    setRemoving(false);
  }

  return (
    <main>
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Control
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0D0F14]">
              Funding
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Payment method used to fund authorized agent purchases.
            </p>
        </div>
        {!paymentMethod && (
          <button
            type="button"
            onClick={openAddCard}
            disabled={loadingSetup}
              className="rounded-lg bg-[#0D0F14] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1a1f2c] disabled:opacity-50"
          >
              {loadingSetup ? "Loading..." : "Add funding source"}
          </button>
        )}
        </div>
      </header>

      <div className="max-w-3xl px-4 py-7 sm:px-8">
        {setupError && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
            {setupError}
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-slate-200/70 bg-white">
          {paymentMethod ? (
            <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <CardBrandIcon brand={paymentMethod.brand} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#0D0F14] capitalize">
                    {paymentMethod.brand} •••• {paymentMethod.last4}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Expires {paymentMethod.expMonth?.toString().padStart(2, "0")}/{paymentMethod.expYear}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">Default</span>
                <button
                  type="button"
                  onClick={openAddCard}
                  disabled={loadingSetup}
                  className="text-xs text-slate-700 hover:text-[#0D0F14] border border-slate-200 hover:border-slate-300 px-3 py-2 min-h-[44px] sm:min-h-0 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6D5BFF]"
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={removing}
                  className="text-xs text-red-600 hover:text-red-700 border border-red-100 hover:border-red-200 px-3 py-2 min-h-[44px] sm:min-h-0 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  {removing ? "Removing..." : "Remove"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center mb-4">
                <svg className="w-5 h-5 text-slate-300" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5}>
                  <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
                  <line x1="1.5" y1="6.5" x2="14.5" y2="6.5" />
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-600">No funding source</p>
              <p className="text-xs text-slate-400 mt-1 max-w-xs leading-relaxed">
                Connect the payment method Spendex uses for authorized purchases and wallet funding events.
              </p>
              <button
                type="button"
                onClick={openAddCard}
                disabled={loadingSetup}
                className="mt-5 rounded-lg bg-[#0D0F14] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1a1f2c] disabled:opacity-50"
              >
                {loadingSetup ? "Loading..." : "Add funding source"}
              </button>
            </div>
          )}
        </div>

        <div className="mt-6 rounded-xl border border-slate-200/70 bg-white p-4">
          <p className="mb-1 text-xs font-medium text-slate-700">How funding is used</p>
          <p className="text-xs leading-relaxed text-slate-500">
            Spendex stores this method with Stripe. Agent payments still pass
            through your rules, consent checks, and transaction log before money
            moves.
          </p>
        </div>
      </div>

      {clientSecret && (
        <AddCardModal
          clientSecret={clientSecret}
          onSuccess={(pm) => {
            setPaymentMethod(pm);
            setClientSecret(null);
          }}
          onClose={() => setClientSecret(null)}
        />
      )}
    </main>
  );
}
