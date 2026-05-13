"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";

export default function CompletePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <CompletePageInner />
    </Suspense>
  );
}

function CompletePageInner() {
  const searchParams = useSearchParams();
  const redirectStatus = searchParams.get("redirect_status");
  const clientSecret = searchParams.get("payment_intent_client_secret");

  const [status, setStatus] = useState<"loading" | "succeeded" | "processing" | "failed">("loading");
  const [description, setDescription] = useState<string>("");

  useEffect(() => {
    if (redirectStatus === "succeeded") setStatus("succeeded");
    else if (redirectStatus === "processing") setStatus("processing");
    else setStatus("failed");

    if (clientSecret) {
      const pk = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      if (pk) {
        loadStripe(pk).then(async (stripe) => {
          if (!stripe) return;
          const { paymentIntent } = await stripe.retrievePaymentIntent(clientSecret);
          if (paymentIntent?.description) setDescription(paymentIntent.description);
        });
      }
    }
  }, [redirectStatus, clientSecret]);

  if (status === "loading") return <LoadingState />;

  if (status === "succeeded") {
    return (
      <Shell>
        <StatusIcon variant="success" />
        <h1 className="text-xl font-semibold text-[#0D0F14] mb-2">Payment confirmed</h1>
        {description && <p className="text-sm text-slate-500 mb-2">{description}</p>}
        <p className="text-sm text-slate-500 leading-relaxed max-w-xs">
          Your payment was approved. Your agent will continue automatically — you can close this tab.
        </p>
      </Shell>
    );
  }

  if (status === "processing") {
    return (
      <Shell>
        <StatusIcon variant="pending" />
        <h1 className="text-xl font-semibold text-[#0D0F14] mb-2">Payment processing</h1>
        <p className="text-sm text-slate-500 leading-relaxed max-w-xs">
          Stripe is processing your payment. Your agent will continue once the payment clears.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <StatusIcon variant="error" />
      <h1 className="text-xl font-semibold text-[#0D0F14] mb-2">Payment failed</h1>
      <p className="text-sm text-slate-500 leading-relaxed max-w-xs mb-6">
        Your payment could not be processed. Please go back and try again, or ask the agent to retry.
      </p>
      <button
        type="button"
        onClick={() => window.history.back()}
        className="bg-[#6D5BFF] hover:bg-[#5b48ff] text-[#0D0F14] text-sm font-semibold px-6 py-2.5 rounded-lg transition-colors"
      >
        Go back
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-center px-4 py-16 text-center">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="font-bold text-[#0D0F14] text-lg tracking-tight">
            Spendex <span className="text-[#6D5BFF]">Pay</span>
          </span>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-10 flex flex-col items-center">
          {children}
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ variant }: { variant: "success" | "pending" | "error" }) {
  return (
    <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-5 ${
      variant === "success" ? "bg-[#6D5BFF]/15" :
      variant === "pending" ? "bg-amber-50" :
      "bg-red-50"
    }`}>
      {variant === "success" && (
        <svg className="w-6 h-6 text-[#3B82F6]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {variant === "pending" && (
        <svg className="w-6 h-6 text-amber-500 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="10" strokeOpacity={0.25} />
          <path d="M12 2a10 10 0 0110 10" strokeLinecap="round" />
        </svg>
      )}
      {variant === "error" && (
        <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-center px-4">
      <div className="text-center mb-8">
        <span className="font-bold text-[#0D0F14] text-lg tracking-tight">
          Spendex <span className="text-[#6D5BFF]">Pay</span>
        </span>
      </div>
      <svg className="w-8 h-8 text-[#6D5BFF] animate-spin" fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity={0.2} strokeWidth={3} />
        <path d="M12 2a10 10 0 0110 10" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
      </svg>
      <p className="text-sm text-slate-400 mt-3">Confirming payment...</p>
    </div>
  );
}
