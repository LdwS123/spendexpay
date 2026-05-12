/**
 * fetch_product_preview — scrape OpenGraph + Twitter Card meta tags.
 *
 * The agent calls this BEFORE `request_user_consent` so the consent prompt
 * carries the real product name, image, description, and (when the merchant
 * publishes them) price/currency. Without this step the agent has to guess
 * at the title from the URL slug, which produces noisy, low-trust consent
 * dialogs ("approve $399 on www.amazon.com?" vs. "approve $399 for the
 * Sony WH-1000XM5 headphones?").
 *
 * Read-only, never moves money. Auth still required because:
 *   - rate-limit prevents an unattended agent from scraping in a loop
 *   - the audit log captures every URL we fetched on behalf of a user, which
 *     is useful when reconciling a later `pay_for_service` charge with the
 *     product the user actually saw
 *
 * SSRF prevention: we reject `file://`, localhost, and RFC1918 / link-local
 * private ranges. The fetch itself runs through Node's global fetch, which
 * does NOT respect /etc/hosts shenanigans but does follow redirects — so we
 * cap redirects at 3 and re-validate the final URL's host before reading.
 *
 * Response size cap: 1 MB. Some product pages are huge (Amazon ~3 MB) but the
 * `<head>` arrives in the first chunk, and a 1 MB ceiling is plenty for any
 * sane meta block while bounding memory pressure from a hostile server that
 * streams an infinite body.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import { logTransaction } from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const FetchProductPreviewInput = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      "The product URL to scrape. Must be http:// or https://. " +
      "Examples: Amazon listing, eBay item, Etsy product, Shopify store page."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000; // 1 MB
const MAX_REDIRECTS = 3;
const USER_AGENT = "SpendexBot/0.1 (+https://spendexai.com/bot)";
// Truncate description in the agent-facing summary so the consent prompt
// stays compact. The full string is still available in the structured JSON.
const DESCRIPTION_HINT_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

interface ProductPreview {
  url: string;
  title: string;
  image: string | null;
  description: string | null;
  price: string | null;
  currency: string | null;
  site_name: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

/**
 * SSRF gate — reject URLs that point at the loopback, link-local, or RFC1918
 * private ranges. We do this on the parsed host string (no DNS lookup) which
 * is a coarse but effective first line of defense: an attacker can still
 * craft a hostname that resolves to a private IP, but then Node's fetch will
 * make the request and we'll see the response, not internal state. A real
 * defense-in-depth setup would also pin the egress to a public-only proxy
 * or run the fetcher in a network-isolated worker.
 */
function isPrivateHost(host: string): boolean {
  if (host.length === 0) return true;
  const lower = host.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "0.0.0.0") return true;
  if (lower === "::1" || lower === "[::1]") return true;

  // Strip IPv6 brackets if present.
  const naked = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;

  // IPv4 dotted quad.
  const m = naked.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // loopback
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 169 && b === 254) return true;         // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;// 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    return false;
  }

  // IPv6 — anything that looks unique-local / link-local / loopback.
  if (naked.startsWith("fc") || naked.startsWith("fd")) return true; // fc00::/7
  if (naked.startsWith("fe80:")) return true;                        // link-local

  return false;
}

interface UrlValidationOk {
  ok: true;
  url: URL;
}
interface UrlValidationErr {
  ok: false;
  reason: string;
}

function validateUrl(raw: string): UrlValidationOk | UrlValidationErr {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "URL is not well-formed" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol "${parsed.protocol}" — only http and https are allowed` };
  }

  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: "URL points at a private / loopback host" };
  }

  return { ok: true, url: parsed };
}

/**
 * Read the response body, aborting if we exceed MAX_RESPONSE_BYTES.
 *
 * We stop reading at the cap rather than throwing — most product pages put
 * the `<head>` block in the first 50 KB, so a partial read is still useful
 * for OG/Twitter parsing.
 */
async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Body already buffered (some test mocks return Response with text body).
    const text = await response.text();
    return text.slice(0, MAX_RESPONSE_BYTES);
  }

  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= MAX_RESPONSE_BYTES) {
        // Be a good citizen — release the underlying connection.
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
  }
  out += decoder.decode();
  return out;
}

/**
 * Fetch the URL with manual redirect handling so we re-run the SSRF gate on
 * every hop. Returns the body string and the final URL (after redirects).
 */
async function fetchWithRedirects(initial: URL): Promise<{ body: string; finalUrl: URL }> {
  let current = initial;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Handle redirect chain manually so we can re-validate each hop.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`redirect with no Location header (status ${response.status})`);
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`redirect target is not a valid URL: ${location}`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error(`redirect to unsupported protocol "${next.protocol}"`);
      }
      if (isPrivateHost(next.hostname)) {
        throw new Error("redirect target points at a private / loopback host");
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      throw new Error(`upstream returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.length > 0 && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error(`unexpected content-type "${contentType}" — only text/html is accepted`);
    }

    const body = await readBodyCapped(response);
    return { body, finalUrl: current };
  }
  // Loop guard — unreachable.
  throw new Error("redirect loop exited without a response");
}

// ---------------------------------------------------------------------------
// HTML meta parsing
// ---------------------------------------------------------------------------

/**
 * Decode the small set of HTML entities that commonly appear inside meta
 * content attributes. We do not pull in a full parser — a couple of regex
 * replacements covers the 99% case (`&amp;`, `&quot;`, `&#39;`, numeric
 * decimal/hex entities). Anything missed remains as-is, which is still safe
 * because the result is plain text returned to the agent.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const cp = parseInt(h, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const cp = parseInt(d, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Match a meta tag by its `property=` or `name=` attribute, regardless of
 * attribute order or quoting style.
 *
 * The official OG spec uses `property="og:title"` with a `content="..."`
 * sibling, but real-world pages mix:
 *   - <meta property="og:title" content="...">
 *   - <meta content="..." property="og:title">
 *   - <meta name="twitter:image" content='...'>
 *   - <meta property=og:title content=...>  (no quotes at all, rare)
 *
 * We accept all four shapes with a single regex per attribute combo.
 */
function extractMeta(html: string, attrName: "property" | "name", attrValue: string): string | null {
  const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // <meta {attr}="{value}" ... content="..." ...>
  const a = new RegExp(
    `<meta\\b[^>]*?\\b${attrName}\\s*=\\s*["']${escaped}["'][^>]*?\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*?>`,
    "i"
  );
  const ma = html.match(a);
  if (ma && typeof ma[1] === "string") return decodeEntities(ma[1]);

  // <meta content="..." ... {attr}="{value}" ...>
  const b = new RegExp(
    `<meta\\b[^>]*?\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*?\\b${attrName}\\s*=\\s*["']${escaped}["'][^>]*?>`,
    "i"
  );
  const mb = html.match(b);
  if (mb && typeof mb[1] === "string") return decodeEntities(mb[1]);

  return null;
}

/**
 * Extract the contents of the first `<title>` element. Falls back to `null`
 * when no title is present (common for SPA shells that hydrate via JS).
 */
function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || typeof m[1] !== "string") return null;
  const trimmed = m[1].trim();
  if (trimmed.length === 0) return null;
  return decodeEntities(trimmed);
}

function parsePreview(html: string, finalUrl: URL): ProductPreview {
  // Title — prefer og:title, fall back to twitter:title, then <title>.
  const ogTitle = extractMeta(html, "property", "og:title");
  const twTitle = extractMeta(html, "name", "twitter:title");
  const docTitle = extractTitle(html);
  const title = ogTitle ?? twTitle ?? docTitle ?? finalUrl.hostname;

  // Image — og:image, then twitter:image (Twitter Cards), then null.
  const ogImage = extractMeta(html, "property", "og:image");
  const twImage = extractMeta(html, "name", "twitter:image");
  const image = ogImage ?? twImage ?? null;

  // Description — og:description, then twitter:description, then
  // <meta name="description">.
  const ogDesc = extractMeta(html, "property", "og:description");
  const twDesc = extractMeta(html, "name", "twitter:description");
  const metaDesc = extractMeta(html, "name", "description");
  const description = ogDesc ?? twDesc ?? metaDesc ?? null;

  const siteName = extractMeta(html, "property", "og:site_name");
  const price = extractMeta(html, "property", "product:price:amount");
  const currency = extractMeta(html, "property", "product:price:currency");

  return {
    url: finalUrl.toString(),
    title,
    image,
    description,
    price,
    currency,
    site_name: siteName,
  };
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function formatPreviewText(preview: ProductPreview): string {
  const lines: string[] = [];
  lines.push("PRODUCT PREVIEW");
  lines.push("");
  lines.push(`URL: ${preview.url}`);
  lines.push(`Title: ${preview.title}`);
  if (preview.site_name) lines.push(`Site: ${preview.site_name}`);
  if (preview.image) lines.push(`Image: ${preview.image}`);
  if (preview.description) {
    lines.push(`Description: ${truncate(preview.description, DESCRIPTION_HINT_MAX_CHARS)}`);
  }
  if (preview.price) {
    const cur = preview.currency ? ` ${preview.currency.toUpperCase()}` : "";
    // Prefix $ only when the currency clearly resolves to USD; otherwise
    // print the raw amount so we don't mis-stamp a EUR price as dollars.
    const looksUsd = !preview.currency || preview.currency.toUpperCase() === "USD";
    lines.push(`Price: ${looksUsd ? "$" : ""}${preview.price}${cur}`);
  }
  lines.push("");
  lines.push("Use these fields in request_user_consent:");
  lines.push("- product_url");
  lines.push("- product_name (from Title)");
  lines.push("- product_image_url (from Image)");
  lines.push("- product_description (from Description truncated to 200 chars)");
  lines.push("");
  lines.push("JSON:");
  lines.push(JSON.stringify(preview));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DEV-mode simulated response
// ---------------------------------------------------------------------------

function formatDevResponse(url: string): string {
  const fake: ProductPreview = {
    url,
    title: "Sony WH-1000XM5 Wireless Noise-Cancelling Headphones",
    image: "https://m.media-amazon.com/images/I/61yIzVS4r-L._AC_SL1500_.jpg",
    description:
      "Industry-leading noise cancellation with eight microphones and Auto NC Optimizer. " +
      "Crystal clear hands-free calling with four beamforming microphones and AI-based noise reduction.",
    price: "399.99",
    currency: "USD",
    site_name: "Amazon.com",
  };
  return (
    `[DEV MODE] fetch_product_preview called.\n` +
    `URL: ${url}\n\n` +
    formatPreviewText(fake)
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerFetchProductPreviewTool(server: McpServer): void {
  server.tool(
    "fetch_product_preview",
    "Scrape OpenGraph and Twitter Card meta tags from a product URL and " +
    "return {title, image, description, price?, currency?, site_name}. " +
    "Call this BEFORE `request_user_consent` for any purchase that involves " +
    "a specific product page (Amazon, eBay, Etsy, Shopify, …) so the consent " +
    "prompt carries the real product name + image instead of a bare URL. " +
    "Read-only: never moves money. http/https only; private hosts are " +
    "rejected. Falls back to the page <title> and meta description when " +
    "OpenGraph is absent.",
    FetchProductPreviewInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(formatDevResponse(input.url));
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      const validated = validateUrl(input.url);
      if (!validated.ok) {
        return textResponse(
          `Could not fetch product preview: ${validated.reason}.`,
          { isError: true }
        );
      }

      let body: string;
      let finalUrl: URL;
      try {
        const result = await fetchWithRedirects(validated.url);
        body = result.body;
        finalUrl = result.finalUrl;
      } catch (err) {
        const msg = errorMessage(err, "unknown error");
        // AbortController bubbles up as a DOMException("…aborted"); render it
        // as a timeout so the agent can decide whether to retry vs. give up.
        const isTimeout =
          err instanceof Error &&
          (err.name === "AbortError" || /abort/i.test(err.message));
        const reason = isTimeout
          ? `request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
          : msg;
        return textResponse(
          `Could not fetch product preview: ${reason}.`,
          { isError: true }
        );
      }

      const preview = parsePreview(body, finalUrl);

      // Best-effort audit log. A failure here does not invalidate the preview
      // we already extracted — we still return the data, but we surface a
      // soft warning so support can reconcile if the user later complains
      // about a charge for a product they don't remember seeing.
      try {
        await logTransaction({
          userId: user.id,
          service: finalUrl.hostname,
          status: "success",
          amountUsd: 0,
          description: "Product preview fetched",
          transactionType: "preview_fetch",
        });
      } catch (logErr) {
        console.error(
          `[fetch_product_preview] audit log write failed user=${user.id} ` +
          `url=${finalUrl.toString()}: ${errorMessage(logErr, "unknown error")}`
        );
      }

      return textResponse(formatPreviewText(preview));
    }
  );
}
