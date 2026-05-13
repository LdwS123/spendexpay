/**
 * Tests for src/lib/intent-classifier-ollama.ts plus the CLASSIFIER_BACKEND
 * factory switching in src/lib/intent-classifier.ts.
 *
 * Network calls are mocked by stubbing the global `fetch`. Supabase and the
 * Anthropic SDK are mocked the same way the legacy intent-classifier test
 * does it so the suites stay aligned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mocks — must precede module-under-test imports.
// ---------------------------------------------------------------------------

const { mockMaybeSingle, mockInsert } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockInsert: vi.fn(),
}));

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

// Anthropic SDK mock — only used by the backend-switching test.
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
// Helper — assemble a fake Ollama /api/chat response.
// ---------------------------------------------------------------------------

function ollamaResponse(jsonContent: unknown, opts?: { ok?: boolean; status?: number }): Response {
  const ok = opts?.ok ?? true;
  const status = opts?.status ?? 200;
  const body = {
    model: "llama3.2:3b",
    message: { role: "assistant", content: JSON.stringify(jsonContent) },
    done: true,
  };
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function rawOllamaResponse(rawContent: string, opts?: { ok?: boolean; status?: number }): Response {
  const ok = opts?.ok ?? true;
  const status = opts?.status ?? 200;
  const body = {
    model: "llama3.2:3b",
    message: { role: "assistant", content: rawContent },
    done: true,
  };
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// OllamaBackend — direct backend tests with the orchestrator bypassed.
// ---------------------------------------------------------------------------

describe("OllamaBackend.classify", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const ORIGINAL_FETCH = globalThis.fetch;
  const ORIGINAL_BASE = process.env["OLLAMA_BASE_URL"];
  const ORIGINAL_MODEL = process.env["OLLAMA_MODEL"];

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn();
    // Cast to keep TS happy without using `any`.
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchSpy as unknown as typeof fetch;
    delete process.env["OLLAMA_BASE_URL"];
    delete process.env["OLLAMA_MODEL"];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = ORIGINAL_FETCH;
    if (ORIGINAL_BASE === undefined) delete process.env["OLLAMA_BASE_URL"];
    else process.env["OLLAMA_BASE_URL"] = ORIGINAL_BASE;
    if (ORIGINAL_MODEL === undefined) delete process.env["OLLAMA_MODEL"];
    else process.env["OLLAMA_MODEL"] = ORIGINAL_MODEL;
  });

  it("parses a valid Ollama response into a normalized IntentClassification", async () => {
    fetchSpy.mockResolvedValueOnce(
      ollamaResponse({
        category: "dev_tools",
        subcategory: "cloud_compute",
        urgency: "medium",
        risk_score: 5,
        reasoning: "Vercel Pro plan upgrade.",
      })
    );

    const { OllamaBackend } = await import("../../lib/intent-classifier-ollama.js");
    const backend = new OllamaBackend();
    const result = await backend.classify({
      service: "vercel",
      description: "Upgrade my-app to Pro",
      amount_usd: 20,
    });

    expect(result).not.toBeNull();
    expect(result?.category).toBe("dev_tools");
    expect(result?.subcategory).toBe("cloud_compute");
    expect(result?.urgency).toBe("medium");
    expect(result?.risk_score).toBe(5);
    expect(result?.source).toBe("llm");
    expect(result?.model).toBe("ollama:llama3.2:3b");
    // Verify call shape: POST to /api/chat with format:json.
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/api/chat");
    const init2 = init as RequestInit;
    expect(init2.method).toBe("POST");
    const sentBody = JSON.parse(init2.body as string) as { format?: string; model?: string };
    expect(sentBody.format).toBe("json");
    expect(sentBody.model).toBe("llama3.2:3b");
  });

  it("uses OLLAMA_BASE_URL and OLLAMA_MODEL when set", async () => {
    process.env["OLLAMA_BASE_URL"] = "http://my-host:9999/";
    process.env["OLLAMA_MODEL"] = "spendex-classifier:v1";
    fetchSpy.mockResolvedValueOnce(
      ollamaResponse({
        category: "shopping",
        subcategory: null,
        urgency: "low",
        risk_score: 20,
        reasoning: "ok",
      })
    );

    const { OllamaBackend } = await import("../../lib/intent-classifier-ollama.js");
    const backend = new OllamaBackend();
    const result = await backend.classify({
      service: "amazon",
      description: "headphones",
      amount_usd: 100,
    });

    expect(result?.model).toBe("ollama:spendex-classifier:v1");
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://my-host:9999/api/chat");
  });

  it("clamps risk_score to [0,100]", async () => {
    fetchSpy.mockResolvedValueOnce(
      ollamaResponse({
        category: "gambling",
        subcategory: null,
        urgency: "low",
        risk_score: 250,
        reasoning: "out of range",
      })
    );

    const { OllamaBackend } = await import("../../lib/intent-classifier-ollama.js");
    const backend = new OllamaBackend();
    const result = await backend.classify({
      service: "foo",
      description: "bar",
      amount_usd: 1,
    });
    expect(result?.risk_score).toBe(100);
  });

  it("returns null when fetch rejects (timeout / network error)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("AbortError: aborted"));
    const { OllamaBackend } = await import("../../lib/intent-classifier-ollama.js");
    const backend = new OllamaBackend();
    const result = await backend.classify({
      service: "anything",
      description: "anything",
      amount_usd: 1,
    });
    expect(result).toBeNull();
  });

  it("returns null on non-2xx HTTP status", async () => {
    fetchSpy.mockResolvedValueOnce(
      ollamaResponse({}, { ok: false, status: 500 })
    );
    const { OllamaBackend } = await import("../../lib/intent-classifier-ollama.js");
    const backend = new OllamaBackend();
    const result = await backend.classify({
      service: "x",
      description: "y",
      amount_usd: 1,
    });
    expect(result).toBeNull();
  });

  it("returns null when the message.content is not valid JSON", async () => {
    fetchSpy.mockResolvedValueOnce(
      rawOllamaResponse("not json at all { broken")
    );
    const { OllamaBackend } = await import("../../lib/intent-classifier-ollama.js");
    const backend = new OllamaBackend();
    const result = await backend.classify({
      service: "x",
      description: "y",
      amount_usd: 1,
    });
    expect(result).toBeNull();
  });

  it("returns null when the JSON object is missing required fields", async () => {
    fetchSpy.mockResolvedValueOnce(
      ollamaResponse({ category: "dev_tools" }) // no urgency/risk_score/reasoning
    );
    const { OllamaBackend } = await import("../../lib/intent-classifier-ollama.js");
    const backend = new OllamaBackend();
    const result = await backend.classify({
      service: "x",
      description: "y",
      amount_usd: 1,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLASSIFIER_BACKEND env-var switching — orchestrator end-to-end.
// ---------------------------------------------------------------------------

describe("classifyIntent — CLASSIFIER_BACKEND switching", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const ORIGINAL_BACKEND = process.env["CLASSIFIER_BACKEND"];
  const ORIGINAL_KEY = process.env["ANTHROPIC_API_KEY"];
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../config.js", () => ({ DEV_MODE: false }));
    mockMaybeSingle.mockReset();
    mockInsert.mockReset();
    mockCreate.mockReset();
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockInsert.mockResolvedValue({ data: null, error: null });
    process.env["ANTHROPIC_API_KEY"] = "sk-test-fake";
    fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchSpy as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = ORIGINAL_FETCH;
    if (ORIGINAL_BACKEND === undefined) delete process.env["CLASSIFIER_BACKEND"];
    else process.env["CLASSIFIER_BACKEND"] = ORIGINAL_BACKEND;
    if (ORIGINAL_KEY === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = ORIGINAL_KEY;
    vi.doUnmock("../../config.js");
  });

  it("CLASSIFIER_BACKEND unset → uses Anthropic backend (default)", async () => {
    delete process.env["CLASSIFIER_BACKEND"];
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_classification",
          input: {
            category: "dev_tools",
            subcategory: "cloud_compute",
            urgency: "medium",
            risk_score: 5,
            reasoning: "haiku",
          },
        },
      ],
    });
    const { classifyIntent, resetBackendForTests } = await import(
      "../../lib/intent-classifier.js"
    );
    resetBackendForTests();
    const result = await classifyIntent({
      service: "vercel",
      description: "Upgrade my-app to Pro",
      amount_usd: 20,
    });
    expect(result.source).toBe("llm");
    expect(result.category).toBe("dev_tools");
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("CLASSIFIER_BACKEND=ollama → uses Ollama backend (no Anthropic call)", async () => {
    process.env["CLASSIFIER_BACKEND"] = "ollama";
    fetchSpy.mockResolvedValueOnce(
      ollamaResponse({
        category: "shopping",
        subcategory: "marketplace",
        urgency: "medium",
        risk_score: 30,
        reasoning: "ollama backend response",
      })
    );
    const { classifyIntent, resetBackendForTests } = await import(
      "../../lib/intent-classifier.js"
    );
    resetBackendForTests();
    const result = await classifyIntent({
      service: "amazon",
      description: "MacBook",
      amount_usd: 1499,
    });
    expect(result.source).toBe("llm");
    expect(result.category).toBe("shopping");
    expect(result.model).toMatch(/^ollama:/);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("CLASSIFIER_BACKEND=ollama + ollama fails → static fallback", async () => {
    process.env["CLASSIFIER_BACKEND"] = "ollama";
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { classifyIntent, resetBackendForTests } = await import(
      "../../lib/intent-classifier.js"
    );
    resetBackendForTests();
    const result = await classifyIntent({
      service: "anything",
      description: "anything",
      amount_usd: 1,
    });
    expect(result.source).toBe("fallback");
    expect(result.category).toBe("unknown");
    expect(result.risk_score).toBe(50);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
