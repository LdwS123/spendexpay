/**
 * get_product_variants — enrich a product URL with the variant axes
 * (color, size, storage, configuration) and a quantity range so the
 * agent can build a complete shopping consent prompt rather than a
 * one-SKU "approve $399 on Amazon" stub.
 *
 * Same three-path flow as `fetch_product_preview`:
 *
 *   1. Cache hit (`product_variants` table) — return immediately. The
 *      row may have been written by either path #2 or #3; both produce
 *      the same shape. 7-day TTL matches the preview cache so a single
 *      consent flow that calls preview+variants reuses or refreshes
 *      both rows together.
 *
 *   2. Server-side scrape — Node fetch with the SpendexBot UA. We
 *      look at JSON-LD application/ld+json blocks for schema.org
 *      Product / Offer trees; this is the only structured variant
 *      source most merchants publish. OpenGraph carries the base
 *      product but not the per-variant axes.
 *
 *   3. Agent-via-browser fallback — when the server fetch hits an
 *      anti-bot block (403/404 with captcha signatures, 200 with decoy
 *      content) OR when the page returns valid HTML but no JSON-LD
 *      variant tree (most merchants render variants via JS), we return
 *      a SCRAPING BLOCKED instruction asking the host agent to open the
 *      URL in its own browser tool and re-call with `agent_extracted`.
 *
 * Same SSRF / response-size / timeout / redirect-validation as
 * fetch-product-preview. Read-only, never moves money. Auth still
 * required so the audit log records who scraped what.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import {
  cacheVariants,
  getCachedVariants,
  logTransaction,
  type ProductVariantOption,
  type ProductVariantsRow,
} from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const AgentVariantSchema = z.object({
  axis: z
    .string()
    .min(1, "axis must be a non-empty string (e.g. \"color\", \"size\", \"storage\")")
    .describe("The variant axis — color, size, storage, model, configuration."),
  name: z
    .string()
    .min(1, "name must be a non-empty string")
    .describe("Human-readable label for this option, e.g. \"Midnight Blue\"."),
  value: z
    .string()
    .min(1, "value must be a non-empty string")
    .describe("Machine identifier the merchant uses, e.g. \"blue-256gb\"."),
  price_delta_usd: z
    .number()
    .finite("price_delta_usd must be a finite number")
    .optional()
    .describe(
      "USD increment relative to base_price_usd when this option is picked. " +
      "Omit or set 0 if the option doesn't change the price."
    ),
  available: z
    .boolean()
    .describe("Whether the merchant currently has stock for this option."),
  image_url: z
    .string()
    .url("image_url must be a valid http(s) URL")
    .optional()
    .describe("Optional per-variant image URL (e.g. the blue colorway photo)."),
});

const AgentExtractedSchema = z.object({
  variants: z
    .array(AgentVariantSchema)
    .min(1, "variants must contain at least one option"),
  base_price_usd: z
    .number()
    .nonnegative("base_price_usd must be >= 0")
    .optional()
    .describe("Base price in USD before any variant deltas are applied."),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code")
    .optional()
    .describe("ISO 4217 currency code — USD, EUR, GBP, etc."),
  min_quantity: z
    .number()
    .int("min_quantity must be an integer")
    .min(1, "min_quantity must be >= 1")
    .optional(),
  max_quantity: z
    .number()
    .int("max_quantity must be an integer")
    .min(1, "max_quantity must be >= 1")
    .optional(),
});

const GetProductVariantsInput = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      "The product URL whose variants you want. Same set of supported sites " +
      "as fetch_product_preview — Shopify, eBay, Etsy via JSON-LD; Amazon / " +
      "Walmart / Apple via the agent_extracted fallback."
    ),
  agent_extracted: AgentExtractedSchema.optional().describe(
    "Optional. Provide this when get_product_variants previously returned a " +
    "SCRAPING BLOCKED instruction and you opened the URL in your browser " +
    "tool to extract the axes manually. The tool will validate, cache, and " +
    "return the same PRODUCT VARIANTS shape as a successful server-side parse."
  ),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)."),
});

// ---------------------------------------------------------------------------
// Tunables — kept in sync with fetch-product-preview so both tools behave
// identically against the same merchant.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "SpendexBot/0.1 (+https://spendexai.com/bot)";
const DEFAULT_MIN_QUANTITY = 1;
const DEFAULT_MAX_QUANTITY = 99;

const BOT_BLOCK_SIGNATURES: ReadonlyArray<string> = [
  "sorry, we just need to make sure you're not a robot",
  "captcha",
  "access denied",
  "robot check",
];

const BAIT_HOSTNAME_NAMES: ReadonlyArray<string> = [
  "amazon",
  "walmart",
  "apple",
  "target",
  "best buy",
  "ebay",
];

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

interface VariantPayload {
  url: string;
  variants: ProductVariantOption[];
  base_price_usd: number | null;
  currency: string | null;
  min_quantity: number;
  max_quantity: number;
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

function isPrivateHost(host: string): boolean {
  if (host.length === 0) return true;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "0.0.0.0") return true;
  if (lower === "::1" || lower === "[::1]") return true;
  const naked = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
  const m = naked.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (naked.startsWith("fc") || naked.startsWith("fd")) return true;
  if (naked.startsWith("fe80:")) return true;
  return false;
}

interface UrlValidationOk { ok: true; url: URL }
interface UrlValidationErr { ok: false; reason: string }

function validateUrl(raw: string): UrlValidationOk | UrlValidationErr {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { return { ok: false, reason: "URL is not well-formed" }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol "${parsed.protocol}" — only http and https are allowed` };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: "URL points at a private / loopback host" };
  }
  return { ok: true, url: parsed };
}

async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
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
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
  }
  out += decoder.decode();
  return out;
}

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

type FetchOutcome =
  | { kind: "ok"; body: string; finalUrl: URL }
  | { kind: "bot_blocked"; status: number; finalUrl: URL }
  | { kind: "error"; reason: string; isTimeout: boolean };

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
      return { kind: "error", reason: errorMessage(err, "unknown error"), isTimeout };
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { kind: "error", reason: `redirect with no Location header (status ${response.status})`, isTimeout: false };
      }
      if (hop === MAX_REDIRECTS) {
        return { kind: "error", reason: `too many redirects (>${MAX_REDIRECTS})`, isTimeout: false };
      }
      let next: URL;
      try { next = new URL(location, current); }
      catch { return { kind: "error", reason: `redirect target is not a valid URL: ${location}`, isTimeout: false }; }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return { kind: "error", reason: `redirect to unsupported protocol "${next.protocol}"`, isTimeout: false };
      }
      if (isPrivateHost(next.hostname)) {
        return { kind: "error", reason: "redirect target points at a private / loopback host", isTimeout: false };
      }
      current = next;
      continue;
    }

    if (response.status === 403 || response.status === 404) {
      const body = response.status === 404 ? await readBodyCapped(response) : "";
      if (looksLikeBotBlock(response.status, body)) {
        return { kind: "bot_blocked", status: response.status, finalUrl: current };
      }
      return { kind: "error", reason: `upstream returned HTTP ${response.status}`, isTimeout: false };
    }

    if (!response.ok) {
      return { kind: "error", reason: `upstream returned HTTP ${response.status}`, isTimeout: false };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.length > 0 && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return { kind: "error", reason: `unexpected content-type "${contentType}" — only text/html is accepted`, isTimeout: false };
    }

    const body = await readBodyCapped(response);
    return { kind: "ok", body, finalUrl: current };
  }
  return { kind: "error", reason: "redirect loop exited without a response", isTimeout: false };
}

// ---------------------------------------------------------------------------
// JSON-LD parsing
// ---------------------------------------------------------------------------

/**
 * Extract every JSON-LD script block from the HTML and JSON.parse each
 * one independently. Malformed blocks are silently skipped — the
 * merchant might publish one valid Product tree alongside an
 * internal-debug block that doesn't parse, and we still want to
 * harvest the valid one.
 */
function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1];
    if (typeof raw !== "string") continue;
    try {
      const parsed = JSON.parse(raw.trim());
      blocks.push(parsed);
    } catch {
      // Skip — many merchants embed templated JSON-LD with placeholders.
    }
  }
  return blocks;
}

interface ParsedOffer {
  price: number | null;
  currency: string | null;
  available: boolean;
  axisLabel: string | null;
  axisValue: string | null;
  sku: string | null;
  image: string | null;
  name: string | null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim().replace(/[^0-9.\-]/g, "");
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function parseOffer(raw: Record<string, unknown>): ParsedOffer {
  let price = asNumber(raw["price"]);
  const priceSpec = raw["priceSpecification"];
  if (price === null && priceSpec && typeof priceSpec === "object") {
    const spec = priceSpec as Record<string, unknown>;
    price = asNumber(spec["price"]);
  }
  let currency = asString(raw["priceCurrency"]);
  if (!currency && priceSpec && typeof priceSpec === "object") {
    const spec = priceSpec as Record<string, unknown>;
    currency = asString(spec["priceCurrency"]);
  }

  const availabilityRaw = asString(raw["availability"]);
  const available =
    availabilityRaw === null
      ? true
      : /InStock|PreOrder|LimitedAvailability/i.test(availabilityRaw) &&
        !/OutOfStock|Discontinued|SoldOut/i.test(availabilityRaw);

  let axisLabel: string | null = null;
  let axisValue: string | null = null;
  const itemOffered = raw["itemOffered"];
  if (itemOffered && typeof itemOffered === "object") {
    const item = itemOffered as Record<string, unknown>;
    const color = asString(item["color"]);
    const size = asString(item["size"]);
    if (color) { axisLabel = "color"; axisValue = color; }
    else if (size) { axisLabel = "size"; axisValue = size; }
  }
  if (!axisLabel) {
    const props = raw["additionalProperty"];
    if (Array.isArray(props) && props.length > 0) {
      for (const p of props) {
        if (p && typeof p === "object") {
          const rec = p as Record<string, unknown>;
          const name = asString(rec["name"]);
          const value = asString(rec["value"]);
          if (name && value) {
            axisLabel = name.toLowerCase();
            axisValue = value;
            break;
          }
        }
      }
    }
  }

  return {
    price,
    currency: currency ? currency.toUpperCase() : null,
    available,
    axisLabel,
    axisValue,
    sku: asString(raw["sku"]),
    image: asString(raw["image"]),
    name: asString(raw["name"]),
  };
}

interface ProductWithOffers {
  productName: string | null;
  productImage: string | null;
  productColors: string[];
  productSizes: string[];
  basePrice: number | null;
  currency: string | null;
  offers: ParsedOffer[];
}

function findProductWithOffers(root: unknown): ProductWithOffers | null {
  const candidates: Record<string, unknown>[] = [];
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === null || node === undefined) continue;
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }
    if (typeof node !== "object") continue;
    const rec = node as Record<string, unknown>;
    candidates.push(rec);
    if (Array.isArray(rec["@graph"])) {
      for (const item of rec["@graph"]) queue.push(item);
    }
  }

  for (const candidate of candidates) {
    const type = candidate["@type"];
    const typeMatches =
      type === "Product" ||
      (Array.isArray(type) && type.some((t) => t === "Product"));
    if (!typeMatches) continue;

    const offersRaw = candidate["offers"];
    const offers: ParsedOffer[] = [];
    if (Array.isArray(offersRaw)) {
      for (const o of offersRaw) {
        if (o && typeof o === "object") {
          offers.push(parseOffer(o as Record<string, unknown>));
        }
      }
    } else if (offersRaw && typeof offersRaw === "object") {
      offers.push(parseOffer(offersRaw as Record<string, unknown>));
    }

    if (offers.length === 0) continue;

    const colorRaw = candidate["color"];
    const sizeRaw = candidate["size"];
    const productColors = Array.isArray(colorRaw)
      ? colorRaw.filter((v): v is string => typeof v === "string")
      : typeof colorRaw === "string"
        ? [colorRaw]
        : [];
    const productSizes = Array.isArray(sizeRaw)
      ? sizeRaw.filter((v): v is string => typeof v === "string")
      : typeof sizeRaw === "string"
        ? [sizeRaw]
        : [];

    let basePrice: number | null = null;
    let currency: string | null = null;
    for (const o of offers) {
      if (o.price !== null) {
        if (basePrice === null || o.price < basePrice) basePrice = o.price;
      }
      if (currency === null && o.currency !== null) currency = o.currency;
    }

    return {
      productName: asString(candidate["name"]),
      productImage: asString(candidate["image"]),
      productColors,
      productSizes,
      basePrice,
      currency,
      offers,
    };
  }
  return null;
}

/**
 * Convert a parsed JSON-LD Product into our `ProductVariantOption[]`
 * shape. Two paths:
 *   - per-offer axes (Offer.itemOffered.color or additionalProperty) →
 *     one option per offer, price_delta = offer.price - basePrice.
 *   - flat color/size lists on the Product → one option per entry,
 *     price_delta 0, available true.
 *
 * Empty result triggers the SCRAPING BLOCKED fallback at the caller.
 */
function offersToVariants(product: ProductWithOffers): ProductVariantOption[] {
  const out: ProductVariantOption[] = [];
  const base = product.basePrice ?? 0;

  const offersWithAxis = product.offers.filter(
    (o) => o.axisLabel !== null && o.axisValue !== null
  );
  if (offersWithAxis.length > 0) {
    for (const offer of offersWithAxis) {
      const delta =
        offer.price !== null && product.basePrice !== null
          ? Math.max(0, offer.price - base)
          : 0;
      const axisLabel = offer.axisLabel as string;
      const axisValue = offer.axisValue as string;
      const opt: ProductVariantOption = {
        axis: axisLabel,
        name: axisValue,
        value: offer.sku ?? axisValue,
        available: offer.available,
      };
      if (delta > 0) opt.price_delta_usd = delta;
      if (offer.image) opt.image_url = offer.image;
      out.push(opt);
    }
    return out;
  }

  for (const color of product.productColors) {
    out.push({ axis: "color", name: color, value: color, available: true });
  }
  for (const size of product.productSizes) {
    out.push({ axis: "size", name: size, value: size, available: true });
  }
  return out;
}

function isBaitProduct(product: ProductWithOffers): boolean {
  if (!product.productName) return false;
  const lower = product.productName.trim().toLowerCase();
  return BAIT_HOSTNAME_NAMES.includes(lower);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatPrice(value: number, currency: string | null): string {
  const cur = currency ? currency.toUpperCase() : "USD";
  const sign = cur === "USD" ? "$" : "";
  return `${sign}${value.toFixed(2)}${cur === "USD" ? "" : " " + cur}`;
}

function formatDelta(value: number, currency: string | null): string {
  if (value === 0) return "$+0";
  const cur = currency ? currency.toUpperCase() : "USD";
  const sign = cur === "USD" ? "$" : "";
  return `${sign}+${value.toFixed(2)}${cur === "USD" ? "" : " " + cur}`;
}

function formatVariantsText(payload: VariantPayload): string {
  const lines: string[] = [];
  lines.push("PRODUCT VARIANTS");
  lines.push("");
  lines.push(`URL: ${payload.url}`);
  if (payload.base_price_usd !== null) {
    lines.push(`Base price: ${formatPrice(payload.base_price_usd, payload.currency)}`);
  }
  lines.push(`Quantity: ${payload.min_quantity}-${payload.max_quantity} allowed`);
  lines.push("");

  const byAxis = new Map<string, ProductVariantOption[]>();
  for (const v of payload.variants) {
    const existing = byAxis.get(v.axis);
    if (existing) existing.push(v);
    else byAxis.set(v.axis, [v]);
  }

  lines.push("Variants:");
  for (const [axis, options] of byAxis) {
    const availableCount = options.filter((o) => o.available).length;
    const labels = options.map((o) => {
      if (o.price_delta_usd !== undefined && o.price_delta_usd !== 0) {
        return `${o.name} (${formatDelta(o.price_delta_usd, payload.currency)})`;
      }
      return o.name;
    });
    const allAvailable = availableCount === options.length;
    const availabilityNote = allAvailable
      ? "all available"
      : `${availableCount}/${options.length} available`;
    lines.push(
      `- ${axis.charAt(0).toUpperCase() + axis.slice(1)}: ` +
      `[${labels.join(", ")}] (${options.length} options, ${availabilityNote})`
    );
  }

  lines.push("");
  lines.push("For consent, pass:");
  lines.push("  product_url, product_name (from earlier fetch_product_preview),");
  lines.push("  chosen variant (e.g. \"Black, 256GB\"),");
  lines.push("  amount_usd = base_price + sum(price_delta of chosen variants)");
  lines.push("");
  lines.push("JSON:");
  lines.push(JSON.stringify({
    url: payload.url,
    base_price_usd: payload.base_price_usd,
    currency: payload.currency,
    min_quantity: payload.min_quantity,
    max_quantity: payload.max_quantity,
    variants: payload.variants,
  }));
  return lines.join("\n");
}

function formatScrapingBlockedInstruction(url: URL): string {
  const lines: string[] = [];
  lines.push("SCRAPING BLOCKED — This merchant blocks variant extraction.");
  lines.push("");
  lines.push("To complete the variants fetch:");
  lines.push(`1. Open this URL in your browser tool: ${url.toString()}`);
  lines.push("2. Extract every variant the page exposes — each color swatch,");
  lines.push("   each size button, each storage tier, each configuration. For");
  lines.push("   each option capture:");
  lines.push("     - axis (\"color\", \"size\", \"storage\", \"model\")");
  lines.push("     - name (human label e.g. \"Midnight Blue\")");
  lines.push("     - value (SKU or merchant identifier)");
  lines.push("     - price_delta_usd (USD over the base price; 0 if same)");
  lines.push("     - available (true/false from the swatch state)");
  lines.push("     - image_url (the per-variant image if visible)");
  lines.push("3. Re-call get_product_variants with the same url AND");
  lines.push("   agent_extracted: {");
  lines.push("     variants: [...],");
  lines.push("     base_price_usd: <number>,");
  lines.push("     currency: \"USD\",");
  lines.push("     min_quantity: 1,");
  lines.push("     max_quantity: 99");
  lines.push("   }");
  lines.push("");
  lines.push(`Detected merchant: ${url.hostname}`);
  return lines.join("\n");
}

function payloadFromCachedRow(row: ProductVariantsRow): VariantPayload {
  return {
    url: row.url,
    variants: row.variants,
    base_price_usd: row.base_price_usd,
    currency: row.currency,
    min_quantity: row.min_quantity,
    max_quantity: row.max_quantity,
  };
}

function payloadFromAgentExtracted(
  url: string,
  data: z.infer<typeof AgentExtractedSchema>
): VariantPayload {
  return {
    url,
    variants: data.variants.map((v) => {
      const opt: ProductVariantOption = {
        axis: v.axis,
        name: v.name,
        value: v.value,
        available: v.available,
      };
      if (v.price_delta_usd !== undefined) opt.price_delta_usd = v.price_delta_usd;
      if (v.image_url !== undefined) opt.image_url = v.image_url;
      return opt;
    }),
    base_price_usd: data.base_price_usd ?? null,
    currency: data.currency ? data.currency.toUpperCase() : null,
    min_quantity: data.min_quantity ?? DEFAULT_MIN_QUANTITY,
    max_quantity: data.max_quantity ?? DEFAULT_MAX_QUANTITY,
  };
}

// ---------------------------------------------------------------------------
// DEV-mode simulated response
// ---------------------------------------------------------------------------

function formatDevResponse(url: string): string {
  const payload: VariantPayload = {
    url,
    base_price_usd: 399.99,
    currency: "USD",
    min_quantity: 1,
    max_quantity: 99,
    variants: [
      { axis: "color", name: "Black", value: "black", available: true },
      { axis: "color", name: "Silver", value: "silver", available: true },
      { axis: "color", name: "Midnight Blue", value: "midnight-blue", available: true },
    ],
  };
  return (
    `[DEV MODE] get_product_variants called.\n` +
    `URL: ${url}\n\n` +
    formatVariantsText(payload)
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGetProductVariantsTool(server: McpServer): void {
  server.tool(
    "get_product_variants",
    "Fetches the variant axes (color, size, storage, configuration) and " +
    "quantity range for a product URL. Server-side scrape first via JSON-LD; " +
    "if the merchant blocks bots OR exposes variants only through JS, returns " +
    "a structured instruction for you to scrape via your browser tool and " +
    "re-call with agent_extracted: {variants, base_price_usd, currency, " +
    "min_quantity, max_quantity}. Results are cached 7 days. Call AFTER " +
    "fetch_product_preview when the user wants to choose a colorway / size " +
    "before approving the charge. Read-only: never moves money.",
    GetProductVariantsInput.shape,
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
          `Could not fetch product variants: ${validated.reason}.`,
          { isError: true }
        );
      }

      // Path 1 (agent_extracted): the agent already scraped via its
      // browser tool. Validate, cache, audit log. Skip the cache read —
      // the agent's fresh data overwrites whatever we had.
      if (input.agent_extracted !== undefined) {
        const payload = payloadFromAgentExtracted(
          validated.url.toString(),
          input.agent_extracted
        );

        try {
          await cacheVariants(
            {
              url: payload.url,
              variants: payload.variants,
              basePriceUsd: payload.base_price_usd,
              currency: payload.currency,
              minQuantity: payload.min_quantity,
              maxQuantity: payload.max_quantity,
            },
            "agent_extracted"
          );
        } catch (cacheErr) {
          console.error(
            `[get_product_variants] cache write failed (agent_extracted) ` +
            `user=${user.id} url=${payload.url}: ${errorMessage(cacheErr, "unknown error")}`
          );
        }

        try {
          await logTransaction({
            userId: user.id,
            service: validated.url.hostname,
            status: "success",
            amountUsd: 0,
            description: "Product variants supplied by agent browser tool",
            transactionType: "variants_fetch_via_agent",
          });
        } catch (logErr) {
          console.error(
            `[get_product_variants] audit log write failed (agent_extracted) ` +
            `user=${user.id} url=${payload.url}: ${errorMessage(logErr, "unknown error")}`
          );
        }

        return textResponse(formatVariantsText(payload));
      }

      // Path 0 (cache hit).
      const canonicalUrl = validated.url.toString();
      const cached = await getCachedVariants(canonicalUrl);
      if (cached) {
        return textResponse(formatVariantsText(payloadFromCachedRow(cached)));
      }

      // Path 2 (server-side scrape + JSON-LD parse).
      const outcome = await fetchWithRedirects(validated.url);

      if (outcome.kind === "bot_blocked") {
        try {
          await logTransaction({
            userId: user.id,
            service: outcome.finalUrl.hostname,
            status: "success",
            amountUsd: 0,
            description: `Product variants blocked by anti-bot (HTTP ${outcome.status}) — agent fallback instruction returned`,
            transactionType: "variants_fetch",
          });
        } catch (logErr) {
          console.error(
            `[get_product_variants] audit log write failed (bot_blocked) ` +
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
          `Could not fetch product variants: ${reason}.`,
          { isError: true }
        );
      }

      const blocks = extractJsonLdBlocks(outcome.body);
      let product: ProductWithOffers | null = null;
      for (const block of blocks) {
        product = findProductWithOffers(block);
        if (product !== null) break;
      }

      const variants = product ? offersToVariants(product) : [];
      if (!product || isBaitProduct(product) || variants.length === 0) {
        try {
          await logTransaction({
            userId: user.id,
            service: outcome.finalUrl.hostname,
            status: "success",
            amountUsd: 0,
            description: !product
              ? "Product variants not parseable from JSON-LD — agent fallback instruction returned"
              : "Product variants blocked by anti-bot (HTTP 200 decoy page) — agent fallback instruction returned",
            transactionType: "variants_fetch",
          });
        } catch (logErr) {
          console.error(
            `[get_product_variants] audit log write failed (no_variants) ` +
            `user=${user.id} url=${outcome.finalUrl.toString()}: ` +
            `${errorMessage(logErr, "unknown error")}`
          );
        }
        return textResponse(formatScrapingBlockedInstruction(outcome.finalUrl));
      }

      const payload: VariantPayload = {
        url: outcome.finalUrl.toString(),
        variants,
        base_price_usd: product.basePrice,
        currency: product.currency,
        min_quantity: DEFAULT_MIN_QUANTITY,
        max_quantity: DEFAULT_MAX_QUANTITY,
      };

      try {
        await cacheVariants(
          {
            url: payload.url,
            variants: payload.variants,
            basePriceUsd: payload.base_price_usd,
            currency: payload.currency,
            minQuantity: payload.min_quantity,
            maxQuantity: payload.max_quantity,
          },
          "server_fetch"
        );
      } catch (cacheErr) {
        console.error(
          `[get_product_variants] cache write failed (server_fetch) ` +
          `user=${user.id} url=${payload.url}: ${errorMessage(cacheErr, "unknown error")}`
        );
      }

      try {
        await logTransaction({
          userId: user.id,
          service: outcome.finalUrl.hostname,
          status: "success",
          amountUsd: 0,
          description: "Product variants fetched",
          transactionType: "variants_fetch",
        });
      } catch (logErr) {
        console.error(
          `[get_product_variants] audit log write failed user=${user.id} ` +
          `url=${outcome.finalUrl.toString()}: ${errorMessage(logErr, "unknown error")}`
        );
      }

      return textResponse(formatVariantsText(payload));
    }
  );
}
