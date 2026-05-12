/**
 * Tests for src/lib/merchant-normalize.ts.
 *
 * The normalizer is on the Stripe Issuing webhook hot path: every
 * authorization request runs through it before we write the audit log.
 * If the mapping table regresses, transactions get tagged with a wrong
 * service slug and `allowed_services` rules silently break. So we cover
 * both the high-traffic vendors and the fallback path.
 */

import { describe, it, expect } from "vitest";
import { normalizeMerchantName, inferMerchantUrl } from "../lib/merchant-normalize";

describe("normalizeMerchantName", () => {
  it("maps Amazon descriptors (multiple variants) to 'amazon'", () => {
    expect(normalizeMerchantName("AMZN MKTPLACE PMTS")).toBe("amazon");
    expect(normalizeMerchantName("AMAZON.COM")).toBe("amazon");
    expect(normalizeMerchantName("AMZN MKTP US*ABC123")).toBe("amazon");
  });

  it("maps Vercel descriptors to 'vercel'", () => {
    expect(normalizeMerchantName("VERCEL.COM")).toBe("vercel");
    expect(normalizeMerchantName("VERCEL INC*PRO PLAN")).toBe("vercel");
  });

  it("maps OpenAI descriptors to 'openai'", () => {
    expect(normalizeMerchantName("OPENAI.COM")).toBe("openai");
    expect(normalizeMerchantName("OPENAI, LLC")).toBe("openai");
  });

  it("maps Anthropic, GitHub, and Modal descriptors", () => {
    expect(normalizeMerchantName("ANTHROPIC PBC")).toBe("anthropic");
    expect(normalizeMerchantName("GITHUB INC")).toBe("github");
    expect(normalizeMerchantName("MODAL LABS")).toBe("modal");
  });

  it("maps Uber Eats and Uber Trip to a single 'uber' slug", () => {
    expect(normalizeMerchantName("UBER TRIP")).toBe("uber");
    expect(normalizeMerchantName("UBER EATS")).toBe("uber");
    expect(normalizeMerchantName("UBER   HELP.UBER.COM")).toBe("uber");
  });

  it("falls back to a sanitized lowercase slug for unknown merchants", () => {
    // Non-alphanumerics stripped, lowercased, capped at 20 chars.
    expect(normalizeMerchantName("Some Random Cafe #42!")).toBe("somerandomcafe42");
    // Cap test: ensure the 20-char limit holds.
    const slug = normalizeMerchantName("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(slug.length).toBe(20);
    expect(slug).toBe("abcdefghijklmnopqrst");
  });

  it("returns 'unknown' for null, undefined, or empty input", () => {
    expect(normalizeMerchantName(null)).toBe("unknown");
    expect(normalizeMerchantName(undefined)).toBe("unknown");
    expect(normalizeMerchantName("")).toBe("unknown");
    // String of only non-alphanumerics also bottoms out at 'unknown'.
    expect(normalizeMerchantName("!!!---")).toBe("unknown");
  });
});

describe("inferMerchantUrl", () => {
  it("returns a homepage URL for known slugs", () => {
    expect(inferMerchantUrl("amazon")).toBe("https://www.amazon.com");
    expect(inferMerchantUrl("vercel")).toBe("https://vercel.com");
    expect(inferMerchantUrl("openai")).toBe("https://openai.com");
  });

  it("returns null for unknown slugs", () => {
    expect(inferMerchantUrl("somerandomcafe42")).toBeNull();
    expect(inferMerchantUrl("")).toBeNull();
  });
});
