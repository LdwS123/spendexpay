/**
 * Tests for src/lib/intent-classifier.ts
 *
 * Every external dependency (Supabase, Anthropic SDK) is mocked so the
 * suite runs offline. The classifier's contract:
 *
 *   1. DEV_MODE → deterministic fake classification, no network.
 *   2. Cache hit → returned without calling the LLM.
 *   3. Cache miss → LLM call → result cached.
 *   4. LLM timeout / error → static fallback.
 *   5. Missing ANTHROPIC_API_KEY → static fallback (does not block).
 *   6. risk_score always clamped to 0-100.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must precede imports of modules under test.
// ---------------------------------------------------------------------------

const { mockMaybeSingle, mockInsert } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockInsert: vi.fn(),
}));

// Builder pattern mimic of the supabase-js query chain.
function buildQuery() {
  const q: Record<string, unknown> = {};
  q["select"] = vi.fn().mockReturnValue(q);
  q["eq"] = vi.fn().mockReturnValue(q);
  q["gt"] = vi.fn().mockReturnValue(q);
  q["order"] = vi.fn().mockReturnValue(q);
  q["limit"] = vi.fn().mockReturnValue(q);
  q["maybeSingle"] = mockMaybeSingle;
  q["insert"] = mockInsert;
  return q;
}

vi.mock("../../lib/db.js", () => ({
  getSupabase: vi.fn().mockReturnValue({
    from: vi.fn().mockImplementation(() => buildQuery()),
  }),
}));

// Anthropic SDK mock — exposes a controllable messages.create.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    public messages = { create: mockCreate };
    constructor(_opts?: unknown) {
      // no-op
    }
  }
  return { default: MockAnthropic };
});

// ---------------------------------------------------------------------------
// DEV-mode tests — config.js mocked separately per-suite.
// ---------------------------------------------------------------------------

describe("classifyIntent — DEV_MODE", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../config.js", () => ({ DEV_MODE: true }));
  });

  afterEach(() => {
    vi.doUnmock("../../config.js");
  });

  it("returns a fake classification without touching DB or LLM", async () => {
    const { classifyIntent } = await import("../../lib/intent-classifier.js");
    const result = await classifyIntent({
      service: "vercel",
      description: "Upgrade my-app to Pro",
      amount_usd: 20,
    });

    expect(result.source).toBe("dev_mode");
    expect(result.category).toBe("dev_tools");
    expect(result.risk_score).toBeGreaterThanOrEqual(0);
    expect(result.risk_score).toBeLessThanOrEqual(100);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("flags known high-risk services even in DEV_MODE", async () => {
    const { classifyIntent } = await import("../../lib/intent-classifier.js");
    const result = await classifyIntent({
      service: "draftkings",
      description: "weekly fantasy entry",
      amount_usd: 200,
    });
    expect(result.category).toBe("gambling");
    expect(result.risk_score).toBeGreaterThanOrEqual(70);
  });
});

// ---------------------------------------------------------------------------
// Non-DEV tests — production path with the Anthropic mock.
// ---------------------------------------------------------------------------

describe("classifyIntent — production path", () => {
  const ORIGINAL_KEY = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../config.js", () => ({ DEV_MODE: false }));
    mockMaybeSingle.mockReset();
    mockInsert.mockReset();
    mockCreate.mockReset();
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockInsert.mockResolvedValue({ data: null, error: null });
    process.env["ANTHROPIC_API_KEY"] = "sk-test-fake";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = ORIGINAL_KEY;
    }
    vi.doUnmock("../../config.js");
  });

  it("returns the cached row without calling the LLM when one is fresh", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        category: "dev_tools",
        subcategory: "cloud_compute",
        urgency: "medium",
        risk_score: 5,
        reasoning: "cached reasoning",
        model: "claude-haiku-4-5-20251001",
      },
      error: null,
    });

    const { classifyIntent } = await import("../../lib/intent-classifier.js");
    const result = await classifyIntent({
      service: "vercel",
      description: "Upgrade my-app to Pro",
      amount_usd: 20,
    });

    expect(result.source).toBe("cache");
    expect(result.category).toBe("dev_tools");
    expect(result.risk_score).toBe(5);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("falls through to the LLM on cache miss, then caches the result", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_classification",
          input: {
            category: "shopping",
            subcategory: "electronics",
            urgency: "medium",
            risk_score: 30,
            reasoning: "consumer electronics purchase on amazon",
          },
        },
      ],
    });

    const { classifyIntent } = await import("../../lib/intent-classifier.js");
    const result = await classifyIntent({
      service: "amazon",
      description: "buy a MacBook",
      amount_usd: 1499,
    });

    expect(result.source).toBe("llm");
    expect(result.category).toBe("shopping");
    expect(result.risk_score).toBe(30);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("clamps risk_score from the LLM into the 0-100 range", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_classification",
          input: {
            category: "gambling",
            subcategory: null,
            urgency: "low",
            risk_score: 150, // ← over the max; classifier must clamp
            reasoning: "out of range to test clamp",
          },
        },
      ],
    });

    const { classifyIntent } = await import("../../lib/intent-classifier.js");
    const result = await classifyIntent({
      service: "foo",
      description: "bar",
      amount_usd: 5,
    });
    expect(result.risk_score).toBe(100);
  });

  it("returns the static fallback when the LLM call throws (timeout / network error)", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockCreate.mockRejectedValueOnce(new Error("AbortError: aborted"));

    const { classifyIntent } = await import("../../lib/intent-classifier.js");
    const result = await classifyIntent({
      service: "anything",
      description: "anything",
      amount_usd: 1,
    });

    expect(result.source).toBe("fallback");
    expect(result.category).toBe("unknown");
    expect(result.risk_score).toBe(50);
    // No cache write on fallback.
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns the static fallback when ANTHROPIC_API_KEY is unset (does not block)", async () => {
    delete process.env["ANTHROPIC_API_KEY"];

    const { classifyIntent } = await import("../../lib/intent-classifier.js");
    const result = await classifyIntent({
      service: "anything",
      description: "anything",
      amount_usd: 1,
    });

    expect(result.source).toBe("fallback");
    expect(result.category).toBe("unknown");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("buildDescriptionHash buckets amounts so $19.99 and $20 share a hash", async () => {
    const { buildDescriptionHash } = await import("../../lib/intent-classifier.js");
    const a = buildDescriptionHash({
      service: "vercel",
      description: "Upgrade to Pro",
      amount_usd: 19.99,
    });
    const b = buildDescriptionHash({
      service: "vercel",
      description: "Upgrade to Pro",
      amount_usd: 20,
    });
    expect(a).toBe(b);
  });

  it("buildDescriptionHash distinguishes wildly different amounts ($20 vs $2000)", async () => {
    const { buildDescriptionHash } = await import("../../lib/intent-classifier.js");
    const small = buildDescriptionHash({
      service: "vercel",
      description: "Upgrade to Pro",
      amount_usd: 20,
    });
    const large = buildDescriptionHash({
      service: "vercel",
      description: "Upgrade to Pro",
      amount_usd: 2000,
    });
    expect(small).not.toBe(large);
  });
});
