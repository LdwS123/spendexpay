/**
 * Tests for src/tools/list-services.ts — registerListServicesTool
 *
 * The tool takes no input and performs no I/O, so the assertions just check
 * that the handler returns a non-empty text payload mentioning the headline
 * services. Nothing here should be mocked.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { registerListServicesTool } from "../../tools/list-services.js";

let handler:
  | ((input: any) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>)
  | undefined;

const mockServer = { tool: vi.fn() };

beforeAll(() => {
  mockServer.tool.mockImplementation(
    (_name: string, _desc: string, _schema: any, h: any) => {
      handler = h;
    }
  );
  registerListServicesTool(mockServer as any);
});

describe("registerListServicesTool", () => {
  it("returns a text response listing first-class and card-accepted services", async () => {
    const result = await handler!({});
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Vercel");
    expect(text).toContain("Modal");
    expect(text).toContain("OpenAI");
    expect(text).toContain("Anthropic API");
    expect(text).toMatch(/Spendex Pay works as a payment method/);
  });
});
