// Pricing strategy for variable-cost services.
//
// Some services (Hugging Face inference, Gamma generation, Cloudflare per-request)
// have variable per-call costs. Others (Supabase Pro) have fixed monthly costs.
// This module centralizes how Spendex computes the amount to charge the user.
//
// The DECISION captured here is a business-model decision, not a technical one:
// Spendex can pass through the provider cost at zero margin, add a fixed markup
// per call, add a percentage markup, or offer a free monthly quota then meter.
// Each choice has revenue and UX implications — see the discussion in the
// onboarding doc.

export interface PricingContext {
  service: "huggingface" | "gamma" | "cloudflare";
  // Provider's own cost in USD, if known. Many providers don't return cost
  // synchronously, so this may be 0 even when usage occurred.
  providerCostUsd?: number;
  // Free-form usage signal: tokens generated, slides produced, requests routed.
  // Each service maps its own unit into this number.
  usageUnits?: number;
}

/**
 * Compute the USD amount to charge the user for one invocation of a
 * variable-cost service.
 *
 * Called once per tool invocation, BEFORE routePayment. The returned amount
 * is what Stripe will charge — it is also what appears in the audit log.
 *
 * TODO(user): implement this function based on your chosen pricing strategy.
 *
 * Constraints:
 *   - Must return a finite non-negative number (NaN/Infinity will crash router).
 *   - Returning 0 short-circuits routePayment (no charge, no Stripe API call).
 *   - This function is called BEFORE the actual provider call, so
 *     ctx.providerCostUsd is usually an *estimate*, not actual usage.
 *   - The function must be deterministic for a given input (auditability).
 *
 * Options to consider (pick one or combine):
 *   A) Pass-through: return ctx.providerCostUsd ?? 0
 *      → Spendex earns nothing per call. Revenue must come from subscriptions.
 *   B) Fixed markup per service:
 *      → const markups = { huggingface: 0.001, gamma: 0.05, cloudflare: 0 };
 *      → return (ctx.providerCostUsd ?? 0) + markups[ctx.service];
 *   C) Percentage markup: return (ctx.providerCostUsd ?? 0) * 1.10
 *      → Scales with usage. Needs accurate providerCostUsd to be fair.
 *   D) Free tier + meter: track usage per user-month, charge after threshold.
 *      → Most complex but gives a generous-feeling product surface.
 */
export function computeChargeAmountUsd(ctx: PricingContext): number {
  // Pass-through: Spendex charges exactly what the provider charged. No margin.
  // Revenue model lives elsewhere (Spendex subscription, take rate on issuing,
  // fixed fees on deploys). For HF Serverless / Gamma / Cloudflare free tier,
  // ctx.providerCostUsd is currently undefined → user is charged $0. When we
  // wire up provider billing APIs (HF dedicated endpoints, Gamma usage, CF
  // analytics) and start populating providerCostUsd at call time, this becomes
  // a real charge automatically with no code change here.
  return ctx.providerCostUsd ?? 0;
}
