/**
 * fetch_product_preview — enrich a product URL into {title, image,
 * description, price?, currency?, site_name} for use in `request_user_consent`.
 *
 * The flow has three paths, tried in this order:
 *
 *   1. Cache hit (product_previews table) — return immediately. Same shape
 *      whether the row was originally written by the server scrape or the
 *      agent_extracted fallback. Cache TTL is 7 days.
 *
 *   2. Server-side scrape — Node `fetch()` with a SpendexBot UA, OpenGraph /
 *      Twitter Card / <title> extraction. Works for the long tail of sites
 *      that publish meta tags (Etsy, Shopify, eBay, most Shopify-clones).
 *
 *   3. Agent-via-browser fallback — when the server fetch hits an anti-bot
 *      block (HTTP 403/404 + classic captcha signatures from Amazon /
 *      Walmart / Apple), we return a structured INSTRUCTION (not an error)
 *      telling the host agent to open the URL in its own browser tool,
 *      extract the fields, and re-call this tool with `agent_extracted: {…}`.
 *      The re-call validates the fields, writes the cache row, and returns
 *      the same PRODUCT PREVIEW shape as path #2.
 *
 * Why this design:
 *   - Amazon/Walmart/Apple are exactly the merchants users most want to
 *     preview before approving a charge, and they all block bots aggressively.
 *     Without the agent fallback, the consent prompt for these sites would
 *     fall back to "approve $399 on www.amazon.com?" which is exactly the
 *     low-trust UX we set out to avoid.
 *   - The agent already has a browser tool available in the host environment
 *     (Claude Code computer-use beta, Operator, Claude Desktop). Asking it
 *     to scrape the page costs ~3-5 seconds + a few tokens; running a real
 *     headless-browser pool on our side would cost a six-figure proxy bill.
 *   - The cache means each blocked merchant only burns the agent's tokens
 *     once per week per URL, not once per consent prompt.
 *
 * Read-only, never moves money. Auth still required: rate-limit prevents
 * an unattended agent from scraping in a loop, and the audit log captures
 * every URL we processed on behalf of a user.
 *
 * SSRF prevention: we reject `file://`, localhost, and RFC1918 / link-local
 * private ranges. We cap redirects at 3 and re-validate the final URL's
 * host before reading. Response size cap: 1 MB.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import {
  cacheProductPreview,
  getCachedProductPreview,
  logTransaction,
  type ProductPreviewRow,
} from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

/**
 * `agent_extracted` shape. Validated separately from the URL so we can
 * surface granular errors ("title must be at least 1 char", "image_url is
 * not a valid URL") to the agent without needing to re-architect the whole
 * tool input.
 *
 * `title` is required because it is the one field every downstream consumer
 * (`request_user_consent`, the consent prompt UI) depends on. Everything
 * else is optional — a preview with just a title is still much better than
 * a bare URL.
 */
const AgentExtractedSchema = z.object({
  title: z
    .string()
    .min(1, "title must be a non-empty string")
    .describe("Product title — the H1 or main heading on the page."),
  image_url: z
    .string()
    .url("image_url must be a valid http(s) URL")
    .optional()
    .describe("The main product image URL."),
  description: z
    .string()
    .optional()
    .describe("Short product summary or bullet text from the page."),
  price: z
    .number()
    .nonnegative("price must be >= 0")
    .optional()
    .describe("Numeric price as displayed on the page (e.g. 399.99)."),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code (USD, EUR, GBP, …)")
    .optional()
    .describe("ISO 4217 currency code — USD, EUR, GBP, etc."),
  site_name: z
    .string()
    .optional()
    .describe("Human-friendly merchant name (e.g. \"Amazon.com\")."),
});

const FetchProductPreviewInput = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      "The product URL to scrape. Must be http:// or https://. " +
      "Examples: Amazon listing, eBay item, Etsy product, Shopify store page."
    ),
  agent_extracted: AgentExtractedSchema.optional().describe(
    "Optional. Provide this when the server-side scrape previously returned a " +
    "SCRAPING BLOCKED instruction and you used your browser tool to extract " +
    "the fields. The tool will validate, cache, and return the same PRODUCT " +
    "PREVIEW shape as a successful server-side scrape."
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

// Substrings (case-insensitive) that, when found in a response body alongside
// a 403/404, mark the response as a bot-block rather than a real error. Keep
// this list short and specific — a false positive here routes a legitimate
// 404 through the agent fallback for no reason.
const BOT_BLOCK_SIGNATURES: ReadonlyArray<string> = [
  "sorry, we just need to make sure you're not a robot",
  "captcha",
  "access denied",
  "robot check",
];

// Hostname-style strings that some merchants return as the OG title/description
// when their anti-bot layer serves a generic "decoy" page on HTTP 200. Amazon's
// is the worst offender — they 200 with title="Amazon", description="Amazon",
// and a share-icon as og:image. Comparison is case-insensitive on a trimmed
// value, so we only need lowercase forms here.
const BAIT_HOSTNAME_TITLES: ReadonlyArray<string> = [
  "amazon",
  "walmart",
  "apple",
  "target",
  "best buy",
  "ebay",
];

// Image URL substrings that identify a generic merchant share/preview asset
// rather than a real product photo. Anything containing one of these is the
// decoy image a merchant serves to bots — never a real listing.
const BAIT_IMAGE_PATTERNS: ReadonlyArray<string> = [
  "share-icons/previewdoh",
  "share/header",
];

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
 * Detect the classic anti-bot blocks. Returns true when the response is a
 * 403 or 404 AND the body matches one of the known anti-bot signatures, OR
 * any 403 regardless of body (Amazon /errors/validateCaptcha returns 503/
 * 403 with an HTML body that contains "captcha", but other CDNs serve a
 * bare 403 with no body at all — we treat that as bot-blocked too).
 */
function looksLikeBotBlock(status: number, body: string): boolean {
  if (status === 403) return true;
  if (status === 404) {
    const lower = body.toLowerCase();
    for (const sig of BOT_BLOCK_SIGNATURES) {
      if (lower.includes(sig)) return true;
    }
    return false;
  }
  return false;
}

/**
 * Result of a server-side fetch attempt.
 *
 * `bot_blocked` is a structured signal back to the caller (not an error)
 * so the tool can return the agent-fallback instruction with `isError: false`.
 */
type FetchOutcome =
  | { kind: "ok"; body: string; finalUrl: URL }
  | { kind: "bot_blocked"; status: number; finalUrl: URL }
  | { kind: "error"; reason: string; isTimeout: boolean };

/**
 * Fetch the URL with manual redirect handling so we re-run the SSRF gate on
 * every hop. Returns a discriminated outcome so the tool can branch on
 * bot-block vs. real error vs. success without re-parsing the error message.
 */
async function fetchWithRedirects(initial: URL): Promise<FetchOutcome> {
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
    } catch (err) {
      clearTimeout(timer);
      const isTimeout =
        err instanceof Error &&
        (err.name === "AbortError" || /abort/i.test(err.message));
      return {
        kind: "error",
        reason: errorMessage(err, "unknown error"),
        isTimeout,
      };
    } finally {
      clearTimeout(timer);
    }

    // Handle redirect chain manually so we can re-validate each hop.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          kind: "error",
          reason: `redirect with no Location header (status ${response.status})`,
          isTimeout: false,
        };
      }
      if (hop === MAX_REDIRECTS) {
        return {
          kind: "error",
          reason: `too many redirects (>${MAX_REDIRECTS})`,
          isTimeout: false,
        };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return {
          kind: "error",
          reason: `redirect target is not a valid URL: ${location}`,
          isTimeout: false,
        };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return {
          kind: "error",
          reason: `redirect to unsupported protocol "${next.protocol}"`,
          isTimeout: false,
        };
      }
      if (isPrivateHost(next.hostname)) {
        return {
          kind: "error",
          reason: "redirect target points at a private / loopback host",
          isTimeout: false,
        };
      }
      current = next;
      continue;
    }

    // Anti-bot detection runs BEFORE the generic !ok check so a 403 from
    // Amazon (with no body) routes through the agent fallback rather than
    // surfacing as a raw "HTTP 403" error to the user.
    if (response.status === 403 || response.status === 404) {
      // We have to read the body to check for the captcha signatures, but
      // only for 404 — 403 is treated as bot-block unconditionally.
      const body = response.status === 404 ? await readBodyCapped(response) : "";
      if (looksLikeBotBlock(response.status, body)) {
        return { kind: "bot_blocked", status: response.status, finalUrl: current };
      }
      return {
        kind: "error",
        reason: `upstream returned HTTP ${response.status}`,
        isTimeout: false,
      };
    }

    if (!response.ok) {
      return {
        kind: "error",
        reason: `upstream returned HTTP ${response.status}`,
        isTimeout: false,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.length > 0 && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return {
        kind: "error",
        reason: `unexpected content-type "${contentType}" — only text/html is accepted`,
        isTimeout: false,
      };
    }

    const body = await readBodyCapped(response);
    return { kind: "ok", body, finalUrl: current };
  }
  // Loop guard — unreachable.
  return { kind: "error", reason: "redirect loop exited without a response", isTimeout: false };
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

/**
 * Detect "bait" / decoy responses — HTTP 200 pages that look syntactically
 * valid but carry placeholder OG content because the merchant's bot wall
 * silently swapped out the real product page. Amazon is the canonical case:
 *   <meta property="og:title" content="Amazon">
 *   <meta property="og:image" content="...share-icons/previewdoh-share...">
 *   <meta property="og:description" content="Amazon">
 *
 * Without this check, the cache (and the consent prompt) would happily show
 * "Title: Amazon, Image: share-icons/previewdoh-…" which is strictly worse
 * than the SCRAPING BLOCKED instruction — the agent has no signal that it
 * needs to scrape via browser tool.
 */
function isBaitContent(parsed: ProductPreview): boolean {
  const titleRaw = parsed.title.trim();
  const titleLower = titleRaw.toLowerCase();

  // Empty title (after trim) — never a real product.
  if (titleRaw.length === 0) return true;

  // Title is a bare merchant hostname like "Amazon" or "Best Buy".
  if (BAIT_HOSTNAME_TITLES.includes(titleLower)) return true;

  // Image URL contains a known decoy/share-icon path.
  if (parsed.image) {
    const imgLower = parsed.image.toLowerCase();
    for (const sig of BAIT_IMAGE_PATTERNS) {
      if (imgLower.includes(sig)) return true;
    }
  }

  // Description repeats the title verbatim (Amazon mirrors "Amazon" into
  // og:description). Compare trimmed values — the merchant may pad either.
  if (parsed.description !== null) {
    const descRaw = parsed.description.trim();
    const descLower = descRaw.toLowerCase();
    if (descRaw.length > 0 && descLower === titleLower) return true;

    // Description is itself a bare merchant hostname.
    if (BAIT_HOSTNAME_TITLES.includes(descLower)) return true;
  }

  return false;
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

/**
 * Render the instruction that asks the host agent to scrape the page via
 * its own browser tool and re-call this MCP tool with `agent_extracted`.
 *
 * Returned with `isError: false` because this is a valid, structured next
 * step the agent should follow — not a failure the agent should surface
 * to the user as an error.
 */
function formatScrapingBlockedInstruction(url: URL): string {
  const lines: string[] = [];
  lines.push("SCRAPING BLOCKED — This merchant uses anti-bot detection.");
  lines.push("");
  lines.push("To complete the product preview:");
  lines.push(`1. Open this URL in your browser tool: ${url.toString()}`);
  lines.push("2. Extract these fields from the page:");
  lines.push("   - Product title (the H1 or main heading)");
  lines.push("   - Product image URL (the main product photo)");
  lines.push("   - Product description (the short bullet/summary)");
  lines.push("   - Price (a number in USD or EUR if displayed)");
  lines.push("3. Re-call fetch_product_preview with the same url AND agent_extracted: {");
  lines.push("     title: \"<extracted>\",");
  lines.push("     image_url: \"<extracted>\",");
  lines.push("     description: \"<extracted>\",");
  lines.push("     price: <extracted_number>");
  lines.push("   }");
  lines.push("");
  lines.push(`Detected merchant: ${url.hostname}`);
  return lines.join("\n");
}

/**
 * Convert a validated `agent_extracted` payload into the in-memory
 * ProductPreview shape we already format for the agent. Numeric price is
 * rendered to a string with up to 2 decimals so the formatter (which works
 * off og:price strings) treats agent-extracted and scraped values
 * identically.
 */
function previewFromAgentExtracted(
  rawUrl: string,
  data: z.infer<typeof AgentExtractedSchema>
): ProductPreview {
  return {
    url: rawUrl,
    title: data.title,
    image: data.image_url ?? null,
    description: data.description ?? null,
    price: data.price === undefined ? null : data.price.toFixed(2),
    currency: data.currency ? data.currency.toUpperCase() : null,
    site_name: data.site_name ?? null,
  };
}

/** Re-render a cached row in the same shape the live scrape produces. */
function previewFromCachedRow(row: ProductPreviewRow): ProductPreview {
  return {
    url: row.url,
    title: row.title ?? new URL(row.url).hostname,
    image: row.image_url,
    description: row.description,
    price: row.price === null ? null : row.price.toFixed(2),
    currency: row.currency,
    site_name: row.site_name,
  };
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
    "Fetches OpenGraph/Twitter Card meta from any product URL to enrich a " +
    "consent prompt. Server-side scrape first; if the merchant blocks bots " +
    "(Amazon, Walmart, Apple), returns a structured instruction for you to " +
    "scrape via your own browser tool, then re-call with agent_extracted: " +
    "{title, image_url, description, price}. Results are cached 7 days. " +
    "Call this BEFORE `request_user_consent` so the prompt carries the real " +
    "product name + image instead of a bare URL. Read-only: never moves money.",
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

      // ---------------------------------------------------------------------
      // Path 1 (agent_extracted): the agent already scraped the page via its
      // own browser tool and is calling back with the data. Validate, cache,
      // audit log, return the same PRODUCT PREVIEW shape as a live scrape.
      //
      // We deliberately do NOT consult the cache here — if the agent went to
      // the trouble of opening the page in its browser, that data is fresher
      // than whatever we had cached and should overwrite it. The hot-path
      // cache hit happens for plain `{url}` calls below.
      // ---------------------------------------------------------------------
      if (input.agent_extracted !== undefined) {
        const preview = previewFromAgentExtracted(
          validated.url.toString(),
          input.agent_extracted
        );

        try {
          await cacheProductPreview({
            url: preview.url,
            title: preview.title,
            imageUrl: preview.image,
            description: preview.description,
            price: input.agent_extracted.price ?? null,
            currency: preview.currency,
            siteName: preview.site_name,
            source: "agent_extracted",
          });
        } catch (cacheErr) {
          // Cache failure is non-fatal — the agent still gets the preview.
          console.error(
            `[fetch_product_preview] cache write failed (agent_extracted) ` +
            `user=${user.id} url=${preview.url}: ${errorMessage(cacheErr, "unknown error")}`
          );
        }

        try {
          await logTransaction({
            userId: user.id,
            service: validated.url.hostname,
            status: "success",
            amountUsd: 0,
            description: "Product preview supplied by agent browser tool",
            transactionType: "preview_fetch_via_agent",
          });
        } catch (logErr) {
          console.error(
            `[fetch_product_preview] audit log write failed (agent_extracted) ` +
            `user=${user.id} url=${preview.url}: ${errorMessage(logErr, "unknown error")}`
          );
        }

        return textResponse(formatPreviewText(preview));
      }

      // ---------------------------------------------------------------------
      // Path 0 (cache hit): a recent scrape for the same URL is still valid,
      // serve it directly. This applies to BOTH source types — a row written
      // by an earlier agent_extracted call is just as good as a row written
      // by the server scraper.
      // ---------------------------------------------------------------------
      const canonicalUrl = validated.url.toString();
      const cached = await getCachedProductPreview(canonicalUrl);
      if (cached) {
        const preview = previewFromCachedRow(cached);
        // No audit log for cache hits — we already logged the original
        // fetch, and re-logging every hit would flood the audit table with
        // duplicates. Ops can still see preview activity by joining on
        // product_previews.created_at.
        return textResponse(formatPreviewText(preview));
      }

      // ---------------------------------------------------------------------
      // Path 2 (server-side scrape): the default path for every URL that
      // does not block bots. We hand the body to parsePreview and write a
      // cache row on success.
      // ---------------------------------------------------------------------
      const outcome = await fetchWithRedirects(validated.url);

      if (outcome.kind === "bot_blocked") {
        // Audit log the block so ops can spot a new anti-bot CDN rolling
        // out at a merchant. transaction_type stays "preview_fetch" with
        // status "success" because the tool call itself succeeded — the
        // structured instruction is a valid response, not a failure.
        try {
          await logTransaction({
            userId: user.id,
            service: outcome.finalUrl.hostname,
            status: "success",
            amountUsd: 0,
            description: `Product preview blocked by anti-bot (HTTP ${outcome.status}) — agent fallback instruction returned`,
            transactionType: "preview_fetch",
          });
        } catch (logErr) {
          console.error(
            `[fetch_product_preview] audit log write failed (bot_blocked) ` +
            `user=${user.id} url=${outcome.finalUrl.toString()}: ` +
            `${errorMessage(logErr, "unknown error")}`
          );
        }

        return textResponse(formatScrapingBlockedInstruction(outcome.finalUrl));
      }

      if (outcome.kind === "error") {
        const reason = outcome.isTimeout
          ? `request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
          : outcome.reason;
        return textResponse(
          `Could not fetch product preview: ${reason}.`,
          { isError: true }
        );
      }

      const preview = parsePreview(outcome.body, outcome.finalUrl);

      // Bait-page detection: the merchant returned HTTP 200 with a generic
      // decoy payload (Amazon's classic share-icon page). Treat it exactly
      // like a 403/404 bot-block — surface the SCRAPING BLOCKED instruction
      // so the agent re-scrapes via its browser tool, and DO NOT write the
      // decoy fields into the cache.
      if (isBaitContent(preview)) {
        try {
          await logTransaction({
            userId: user.id,
            service: outcome.finalUrl.hostname,
            status: "success",
            amountUsd: 0,
            description:
              "Product preview blocked by anti-bot (HTTP 200 decoy page) — agent fallback instruction returned",
            transactionType: "preview_fetch",
          });
        } catch (logErr) {
          console.error(
            `[fetch_product_preview] audit log write failed (bait_page) ` +
            `user=${user.id} url=${outcome.finalUrl.toString()}: ` +
            `${errorMessage(logErr, "unknown error")}`
          );
        }
        return textResponse(formatScrapingBlockedInstruction(outcome.finalUrl));
      }

      // Write cache row. Numeric price is best-effort: og:price:amount is a
      // string and many sites publish junk like "from $19.99", so we only
      // store it as a number when it parses cleanly.
      const numericPrice = preview.price !== null && /^-?\d+(\.\d+)?$/.test(preview.price)
        ? Number(preview.price)
        : null;
      try {
        await cacheProductPreview({
          url: preview.url,
          title: preview.title,
          imageUrl: preview.image,
          description: preview.description,
          price: numericPrice,
          currency: preview.currency,
          siteName: preview.site_name,
          source: "server_fetch",
        });
      } catch (cacheErr) {
        console.error(
          `[fetch_product_preview] cache write failed (server_fetch) ` +
          `user=${user.id} url=${preview.url}: ${errorMessage(cacheErr, "unknown error")}`
        );
      }

      // Best-effort audit log. A failure here does not invalidate the preview
      // we already extracted — we still return the data, but we surface a
      // soft warning so support can reconcile if the user later complains
      // about a charge for a product they don't remember seeing.
      try {
        await logTransaction({
          userId: user.id,
          service: outcome.finalUrl.hostname,
          status: "success",
          amountUsd: 0,
          description: "Product preview fetched",
          transactionType: "preview_fetch",
        });
      } catch (logErr) {
        console.error(
          `[fetch_product_preview] audit log write failed user=${user.id} ` +
          `url=${outcome.finalUrl.toString()}: ${errorMessage(logErr, "unknown error")}`
        );
      }

      return textResponse(formatPreviewText(preview));
    }
  );
}
