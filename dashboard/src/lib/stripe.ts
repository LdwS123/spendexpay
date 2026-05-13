import Stripe from "stripe";

// Construct the Stripe client lazily. Same reasoning as in src/lib/supabase.ts:
// Next.js loads every server module during the "Collecting page data" build
// phase, and a top-level `new Stripe(undefined!, ...)` would crash the entire
// build the moment STRIPE_SECRET_KEY is unset on the build env. The Proxy
// preserves the existing API (`stripe.paymentIntents.create(...)`) while
// deferring instantiation until the first property access at runtime.

let cached: Stripe | null = null;

function makeStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Add it to .env.local — see .env.example."
    );
  }
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    if (!cached) cached = makeStripe();
    return Reflect.get(cached, prop, receiver);
  },
});
