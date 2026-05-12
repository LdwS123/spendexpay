"use client";

/**
 * PaymentForm — Client Component.
 *
 * Renders the Stripe Elements payment form for Apple Pay / Google Pay.
 * This component runs in the browser — client_secret is only present
 * in memory here and is never written to the URL, localStorage, or any log.
 *
 * Props come from the server component (page.tsx) which fetched client_secret
 * via the Stripe API using the server secret key.
 */

import { useState } from "react";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";

interface PaymentFormProps {
  clientSecret: string;
  publishableKey: string;
  amountUsd: number;
  paymentUi?: "apple_pay" | "google_pay";
}

// loadStripe is called once at module level to avoid re-creating the Stripe
// object on every render. The publishableKey is safe to expose to the browser.
let stripePromise: ReturnType<typeof loadStripe> | null = null;

function getStripe(publishableKey: string) {
  if (!stripePromise) {
    stripePromise = loadStripe(publishableKey);
  }
  return stripePromise;
}

export function PaymentForm({
  clientSecret,
  publishableKey,
  amountUsd,
  paymentUi,
}: PaymentFormProps) {
  const stripe = getStripe(publishableKey);

  return (
    <Elements
      stripe={stripe}
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#0284c7",
            borderRadius: "8px",
            fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
          },
        },
      }}
    >
      <CheckoutForm amountUsd={amountUsd} paymentUi={paymentUi} />
    </Elements>
  );
}

// ── Inner form — has access to Stripe.js hooks ───────────────────────────────

function CheckoutForm({
  amountUsd,
  paymentUi,
}: {
  amountUsd: number;
  paymentUi?: "apple_pay" | "google_pay";
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!stripe || !elements) {
      // Stripe.js has not finished loading — disable the button until ready.
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    // confirmPayment submits the payment and redirects to return_url on success.
    // For Apple Pay / Google Pay, Stripe shows the native wallet sheet before
    // the redirect — no extra code needed on our side.
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        // Return URL shown after the user approves in their wallet.
        // On success Stripe appends ?payment_intent=...&payment_intent_client_secret=...&redirect_status=succeeded
        return_url: `${window.location.origin}/pay/complete`,
      },
    });

    // confirmPayment only resolves with an error — on success it redirects.
    if (error) {
      // Stripe error messages are user-friendly by design.
      setErrorMessage(error.message ?? "An unexpected error occurred.");
      setIsLoading(false);
    }
  }

  const buttonLabel =
    paymentUi === "apple_pay"
      ? "Pay with Apple Pay"
      : paymentUi === "google_pay"
        ? "Pay with Google Pay"
        : `Pay $${amountUsd.toFixed(2)}`;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Stripe Elements renders the payment method selector (Apple Pay,
          Google Pay, or card depending on device/browser capabilities). */}
      <PaymentElement
        options={{
          // Prefer wallet methods (Apple Pay / Google Pay) on supported devices.
          // Falls back to card form on unsupported browsers.
          wallets: {
            applePay: "auto",
            googlePay: "auto",
          },
        }}
      />

      {errorMessage && (
        <div
          role="alert"
          className="bg-red-50 border border-red-100 text-red-700 text-sm px-4 py-3 rounded-lg"
        >
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={!stripe || !elements || isLoading}
        className="w-full bg-slate-900 hover:bg-slate-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
      >
        {isLoading ? (
          <>
            <svg
              className="animate-spin h-4 w-4 text-white"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Processing...
          </>
        ) : (
          buttonLabel
        )}
      </button>

      <p className="text-center text-xs text-slate-400">
        By confirming, you authorize Spendex Pay to charge your selected payment
        method for the amount shown above.
      </p>
    </form>
  );
}
