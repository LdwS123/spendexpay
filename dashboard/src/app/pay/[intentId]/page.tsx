import type { Metadata } from "next";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { PaymentForm } from "./PaymentForm";

export const metadata: Metadata = {
  title: "Approve payment",
};

interface PageProps {
  params: Promise<{ intentId: string }>;
}

export default async function PayPage({ params }: PageProps) {
  const { intentId } = await params;

  if (!intentId.startsWith("pi_")) {
    return <StatusPage variant="error" heading="Invalid payment link" body="This payment link is malformed. Ask the agent to retry the operation to generate a new link." />;
  }

  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.retrieve(intentId);
  } catch (err) {
    const isNotFound =
      err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 404;
    return (
      <StatusPage
        variant="error"
        heading={isNotFound ? "Payment not found" : "Could not load payment"}
        body={
          isNotFound
            ? "This payment link has expired or does not exist. Ask the agent to retry."
            : "There was a problem loading your payment. Please try again in a moment."
        }
      />
    );
  }

  if (intent.status === "succeeded") {
    return (
      <StatusPage
        variant="success"
        heading="Payment confirmed"
        body={`$${(intent.amount / 100).toFixed(2)} for "${intent.description ?? "Dev tool payment"}" was successfully charged. Your agent will continue automatically.`}
      />
    );
  }

  if (intent.status === "canceled") {
    return <StatusPage variant="error" heading="Payment canceled" body="This payment was canceled. Ask the agent to retry the operation to create a new payment." />;
  }

  if (intent.status === "processing") {
    return (
      <StatusPage
        variant="pending"
        heading="Payment processing"
        body={`$${(intent.amount / 100).toFixed(2)} for "${intent.description ?? "Dev tool payment"}" is being processed by Stripe.`}
      />
    );
  }

  const clientSecret = intent.client_secret;
  if (!clientSecret) {
    return <StatusPage variant="error" heading="Payment configuration error" body="The payment could not be initialized. Ask the agent to retry." />;
  }

  const amountUsd = intent.amount / 100;
  const description = intent.description ?? "Dev tool payment";
  const paymentUi = intent.metadata["payment_ui"] as "apple_pay" | "google_pay" | undefined;

  return (
    <Shell>
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="bg-[#070d18] text-white px-8 py-8 text-center">
          <p className="text-xs font-medium text-white/40 uppercase tracking-widest mb-2">Amount due</p>
          <p className="text-4xl font-bold tracking-tight">${amountUsd.toFixed(2)}</p>
          <p className="text-sm text-white/50 mt-2">{description}</p>
        </div>

        {paymentUi && (
          <div className="px-8 pt-5 flex items-center justify-center">
            <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-500 bg-slate-50 border border-slate-100 px-3 py-1.5 rounded-full">
              {paymentUi === "apple_pay" ? (
                <>
                  <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
                    <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.42c1.42.07 2.38.74 3.2.8 1.22-.24 2.39-.93 3.7-.84 1.58.12 2.76.74 3.52 1.88-3.25 1.94-2.47 6.09.5 7.28-.57 1.54-1.33 3.07-2.92 3.74zM12.03 7.25C11.88 5.02 13.69 3.18 15.77 3c.28 2.51-2.27 4.38-3.74 4.25z" />
                  </svg>
                  Pay with Apple Pay
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  Pay with Google Pay
                </>
              )}
            </span>
          </div>
        )}

        <div className="px-8 py-6">
          <PaymentForm
            clientSecret={clientSecret}
            publishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!}
            amountUsd={amountUsd}
            paymentUi={paymentUi}
          />
        </div>
      </div>

      <p className="text-center text-xs text-slate-400 mt-6">
        Payments processed securely by{" "}
        <a href="https://stripe.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-600 transition-colors">
          Stripe
        </a>
        . Spendex Pay never stores your card number.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="font-bold text-[#0a1220] text-lg tracking-tight">
            Spendex <span className="text-[#00e5b4]">Pay</span>
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

type Variant = "success" | "error" | "pending";

function StatusPage({ variant, heading, body }: { variant: Variant; heading: string; body: string }) {
  return (
    <Shell>
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-10 flex flex-col items-center text-center">
        <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-5 ${
          variant === "success" ? "bg-[#00e5b4]/15" :
          variant === "pending" ? "bg-amber-50" :
          "bg-red-50"
        }`}>
          {variant === "success" && <CheckIcon className="w-6 h-6 text-[#00a882]" />}
          {variant === "pending" && <ClockIcon className="w-6 h-6 text-amber-500 animate-spin" />}
          {variant === "error"   && <XIcon className="w-6 h-6 text-red-500" />}
        </div>
        <h1 className="text-xl font-semibold text-[#0a1220] mb-2">{heading}</h1>
        <p className="text-sm text-slate-500 leading-relaxed max-w-xs">{body}</p>
      </div>
    </Shell>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function XIcon({ className }: { className?: string }) {
  return <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /></svg>;
}
function ClockIcon({ className }: { className?: string }) {
  return <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" strokeLinecap="round" /></svg>;
}
