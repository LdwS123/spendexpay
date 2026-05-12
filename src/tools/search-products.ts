/**
 * search_products — return the top N products matching a query on a given
 * merchant.
 *
 * Use case: an agent gets a request like "find me a Sony noise-cancelling
 * headphone under $400 on Amazon". Instead of pushing the user back to
 * amazon.com to copy/paste a URL, the agent can call this tool, get a short
 * structured list of candidate products, then hand the chosen URL to
 * `fetch_product_preview` and finally `request_user_consent` before charging.
 *
 * Three execution paths, tried in this order:
 *
 *   1. `agent_extracted.results` supplied — the host agent already opened the
 *      merchant in its own browser tool and extracted the list of results.
 *      We validate the shape, cap to `max_results`, optionally filter by
 *      `max_price_usd`, and return a formatted summary. This is the path most
 *      real-world calls flow through, because the merchants users care about
 *      (Amazon, Walmart, Apple, eBay, Target, Best Buy) all aggressively
 *      block bots on their search endpoints just as they do on product pages.
 *
 *   2. Server-side scrape — for merchants we can reach without anti-bot
 *      friction we attempt a basic Google Shopping vertical search
 *      (`https://www.google.com/search?q=<query>+site:<merchant>&tbm=shop`)
 *      and parse the first handful of anchor cards. The result is
 *      intentionally low-fidelity — it exists so the V1 demo flow has a
 *      path that does not require the agent to scrape — and is short-
 *      circuited the moment Google returns a bot-block.
 *
 *   3. Server scrape blocked / returned nothing usable — fall back to the
 *      same SCRAPING BLOCKED instruction `fetch_product_preview` returns
 *      when it hits an anti-bot wall, telling the agent to run the search
 *      via its own browser tool and re-call `search_products` with the
 *      results in `agent_extracted.results`.
 *
 * Read-only, never moves money. Full auth (rate-limit, emergency-stop,
 * token-format, user-lookup) still runs so a runaway agent cannot loop on
 * the search endpoint.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import { logTransaction } from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

/**
 * Shape of a single agent-extracted result. `url` and `title` are required
 * because every downstream consumer (the formatter, the agent's follow-up
 * `fetch_product_preview` call) depends on them. Everything else is
 * optional — a row with just a URL + title is still actionable.
 */
const AgentResultSchema = z.object({
  url: z
    .string()
    .url("url must be a valid http(s) URL")
    .describe("Direct link to the product page on the merchant."),
  title: z
    .string()
    .min(1, "title must be a non-empty string")
    .describe("Product title — the listing's main heading."),
  image_url: z
    .string()
    .url("image_url must be a valid http(s) URL")
    .optional()
    .describe("Main product thumbnail URL."),
  price_usd: z
    .number()
    .nonnegative("price_usd must be >= 0")
    .optional()
    .describe("Price in USD as a number (e.g. 399.99)."),
  rating: z
    .number()
    .min(0, "rating must be between 0 and 5")
    .max(5, "rating must be between 0 and 5")
    .optional()
    .describe("Star rating, 0-5."),
  review_count: z
    .number()
    .int("review_count must be an integer")
    .nonnegative("review_count must be >= 0")
    .optional()
    .describe("Number of customer reviews on the listing."),
  prime_eligible: z
    .boolean()
    .optional()
    .describe("Amazon-specific: whether the listing is Prime-eligible."),
});

const AgentExtractedSchema = z.object({
  results: z
    .array(AgentResultSchema)
    .min(1, "agent_extracted.results must contain at least one row")
    .describe("Array of product results scraped from the merchant by the agent."),
});

const SearchProductsInput = z.object({
  merchant: z
    .string()
    .min(1, "merchant must be a non-empty string")
    .describe(
      "Merchant identifier - either a short keyword (\"amazon\", \"ebay\", " +
      "\"google_shopping\", \"walmart\", \"target\", \"bestbuy\") or a bare " +
      "hostname (e.g. \"www.amazon.com\")."
    ),
  query: z
    .string()
    .min(1, "query must be a non-empty string")
    .describe("Search query - natural language. e.g. \"sony noise cancelling headphones\"."),
  max_price_usd: z
    .number()
    .positive("max_price_usd must be > 0")
    .optional()
    .describe("Optional ceiling - drop results whose price_usd exceeds this value."),
  max_results: z
    .number()
    .int("max_results must be an integer")
    .positive("max_results must be > 0")
    .optional()
    .describe("How many results to return. Default 5, max 20."),
  agent_extracted: AgentExtractedSchema.optional().describe(
    "Optional. Provide this when a previous call returned a SCRAPING BLOCKED " +
    "instruction and you used your browser tool to run the search yourself. " +
    "The tool validates each row, caps to max_results, optionally filters by " +
    "max_price_usd, and returns the same SEARCH RESULTS shape as a successful " +
    "server-side run."
  ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 20;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000; // 1 MB
const USER_AGENT = "SpendexBot/0.1 (+https://spendexai.com/bot)";

// Merchants that are known to reliably block server-side scrapes. We
// short-circuit the Google Shopping detour for these and go straight to the
// SCRAPING BLOCKED instruction so the agent does not waste a fetch round-trip.
const BLOCKED_MERCHANTS: ReadonlyArray<string> = [
  "amazon",
  "walmart",
  "apple",
  "target",
  "best buy",
  "bestbuy",
  "ebay",
];

// Substrings that indicate Google itself routed us through a captcha wall.
// Hitting one of these means even the Google Shopping fallback failed.
const GOOGLE_BLOCK_SIGNATURES: ReadonlyArray<string> = [
  "unusual traffic",
  "captcha",
  "/sorry/",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NormalizedResult {
  url: string;
  title: string;
  image_url: string | null;
  price_usd: number | null;
  rating: number | null;
  review_count: number | null;
  prime_eligible: boolean | null;
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
 * Resolve a `merchant` input into a (label, hostname) pair used both in
 * the formatted output and in the Google Shopping `site:` filter.
 *
 * Accepts short keywords ("amazon"), full hostnames ("www.amazon.com"), or
 * the special "google_shopping" sentinel (which skips the `site:` filter).
 */
function resolveMerchant(raw: string): { label: string; siteFilter: string | null } {
  const lower = raw.trim().toLowerCase();
  if (lower.length === 0) return { label: raw, siteFilter: null };

  switch (lower) {
    case "amazon":
      return { label: "amazon", siteFilter: "amazon.com" };
    case "ebay":
      return { label: "ebay", siteFilter: "ebay.com" };
    case "walmart":
      return { label: "walmart", siteFilter: "walmart.com" };
    case "target":
      return { label: "target", siteFilter: "target.com" };
    case "best buy":
    case "bestbuy":
      return { label: "best buy", siteFilter: "bestbuy.com" };
    case "apple":
      return { label: "apple", siteFilter: "apple.com" };
    case "google_shopping":
    case "google":
      return { label: "google_shopping", siteFilter: null };
    default: {
      // Treat as a bare hostname. Strip a leading `www.` for the display
      // label so "www.amazon.com" reads as "amazon.com" in the header.
      const host = lower.replace(/^www\./, "");
      return { label: host, siteFilter: host };
    }
  }
}

/** Returns true when the merchant label appears in the known-blocked list. */
function merchantIsKnownBlocked(label: string): boolean {
  return BLOCKED_MERCHANTS.includes(label);
}

/** Apply `max_price_usd` (when set) and clamp the array to `cap`. */
function clampAndFilter(
  results: NormalizedResult[],
  cap: number,
  maxPriceUsd: number | undefined
): NormalizedResult[] {
  const filtered = maxPriceUsd === undefined
    ? results
    : results.filter((r) => r.price_usd === null || r.price_usd <= maxPriceUsd);
  return filtered.slice(0, cap);
}

function normalizeAgentRow(
  row: z.infer<typeof AgentResultSchema>
): NormalizedResult {
  return {
    url: row.url,
    title: row.title,
    image_url: row.image_url ?? null,
    price_usd: row.price_usd ?? null,
    rating: row.rating ?? null,
    review_count: row.review_count ?? null,
    prime_eligible: row.prime_eligible ?? null,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatPriceUsd(price: number | null): string {
  if (price === null) return "price unknown";
  // Two decimals when there is a fractional component, no decimals when the
  // value is a clean integer dollar amount.
  if (Number.isInteger(price)) return `$${price}`;
  return `$${price.toFixed(2)}`;
}

function formatReviewCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function formatOneResult(idx: number, r: NormalizedResult): string {
  const lines: string[] = [];
  const headerBits: string[] = [];
  headerBits.push(`${idx}. ${r.title}`);
  headerBits.push(`(${formatPriceUsd(r.price_usd)})`);
  if (r.rating !== null) {
    let ratingLine = `* ${r.rating.toFixed(1)}`;
    if (r.review_count !== null) {
      ratingLine += ` (${formatReviewCount(r.review_count)} reviews)`;
    }
    headerBits.push(ratingLine);
  }
  if (r.prime_eligible === true) headerBits.push("[Prime]");

  lines.push(headerBits.join(" "));
  lines.push(`   ${r.url}`);
  if (r.image_url) lines.push(`   Image: ${r.image_url}`);
  return lines.join("\n");
}

function formatSearchResults(
  query: string,
  merchantLabel: string,
  results: NormalizedResult[]
): string {
  if (results.length === 0) {
    return (
      `SEARCH RESULTS - 0 matches for "${query}" on ${merchantLabel}\n\n` +
      `No products matched the query (or all were filtered out by max_price_usd). ` +
      `Broaden the query or raise the price ceiling and try again.`
    );
  }

  const lines: string[] = [];
  lines.push(
    `SEARCH RESULTS - top ${results.length} for "${query}" on ${merchantLabel}`
  );
  lines.push("");
  results.forEach((r, i) => {
    lines.push(formatOneResult(i + 1, r));
    lines.push("");
  });
  lines.push(
    "Next steps: pass any URL above to `fetch_product_preview` to enrich, " +
    "then `request_user_consent` to confirm purchase, then `pay_for_service` " +
    "to charge."
  );
  lines.push("");
  lines.push("JSON:");
  lines.push(JSON.stringify(results));
  return lines.join("\n");
}

/**
 * Render the SCRAPING BLOCKED instruction that asks the host agent to run
 * the search through its own browser tool and re-call this MCP tool with
 * `agent_extracted.results`.
 *
 * Returned with `isError: false` because this is a structured next step the
 * agent should follow — not a failure the agent should surface to the user
 * as an error.
 */
function formatScrapingBlockedInstruction(
  merchantLabel: string,
  query: string,
  maxResults: number,
  maxPriceUsd: number | undefined
): string {
  const lines: string[] = [];
  lines.push("SCRAPING BLOCKED - This merchant blocks server-side product search.");
  lines.push("");
  lines.push("To complete the search:");
  lines.push(
    `1. Open the merchant's search page in your browser tool for "${query}"` +
    (maxPriceUsd !== undefined ? ` under $${maxPriceUsd}` : "") +
    ` on ${merchantLabel}.`
  );
  lines.push(`2. Extract the top ${maxResults} listings. For each row capture:`);
  lines.push("   - url        (direct link to the product page)");
  lines.push("   - title      (the listing's main heading)");
  lines.push("   - image_url  (optional - main thumbnail)");
  lines.push("   - price_usd  (optional - number, no $ sign)");
  lines.push("   - rating     (optional - 0 to 5)");
  lines.push("   - review_count (optional - integer)");
  lines.push("   - prime_eligible (optional - Amazon only, boolean)");
  lines.push("3. Re-call search_products with the same merchant + query AND:");
  lines.push("     agent_extracted: { results: [ ...rows ] }");
  lines.push("");
  lines.push(`Detected merchant: ${merchantLabel}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Google Shopping fallback scraper
// ---------------------------------------------------------------------------

interface GoogleScrapeOk {
  kind: "ok";
  results: NormalizedResult[];
}
interface GoogleScrapeBlocked {
  kind: "blocked";
}
interface GoogleScrapeError {
  kind: "error";
  reason: string;
}
type GoogleScrapeOutcome = GoogleScrapeOk | GoogleScrapeBlocked | GoogleScrapeError;

/**
 * Read up to MAX_RESPONSE_BYTES of a Response body. Matches the pattern used
 * by fetch_product_preview so server scrapes have a uniform memory ceiling.
 */
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

/**
 * Try to extract a small set of NormalizedResult rows from a Google Shopping
 * SERP HTML payload. Best-effort: Google ships its results inside blobs that
 * change layout frequently, so we only mine the lowest-common-denominator
 * signals (anchor href + visible title near a price string). If we cannot
 * find at least one row we return an empty array, which the caller treats as
 * "fallback ineffective" and routes through the SCRAPING BLOCKED instruction.
 */
function parseGoogleShoppingHtml(html: string): NormalizedResult[] {
  const lower = html.toLowerCase();
  for (const sig of GOOGLE_BLOCK_SIGNATURES) {
    if (lower.includes(sig)) return [];
  }

  const results: NormalizedResult[] = [];

  // Google Shopping wraps each product card in an `<a>` whose href starts
  // with "/url?q=" and points at the merchant page. Adjacent text usually
  // contains the listing title and a `$NNN` price token. This regex is
  // deliberately permissive — it is acceptable to return zero rows; what we
  // must avoid is returning a confidently wrong row.
  const cardPattern =
    /<a [^>]*href="\/url\?q=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardPattern.exec(html)) !== null && results.length < MAX_RESULTS_CAP) {
    const rawHref = m[1];
    const inner = m[2];
    if (typeof rawHref !== "string" || typeof inner !== "string") continue;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(decodeURIComponent(rawHref));
    } catch {
      continue;
    }
    // Skip non-product internal links (Google itself, image search, …).
    if (parsedUrl.hostname.endsWith("google.com")) continue;

    // Strip tags from the inner HTML to derive a title candidate.
    const textOnly = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (textOnly.length === 0) continue;

    // Pull the first `$NNN[.NN]` token as a price hint.
    const priceMatch = textOnly.match(/\$(\d{1,5}(?:\.\d{1,2})?)/);
    const priceUsd = priceMatch ? Number(priceMatch[1]) : null;

    // Title heuristic: take the longest run of non-$ text up to 120 chars.
    const title = textOnly.replace(/\$\d[\d.,]*/g, "").trim().slice(0, 120);
    if (title.length === 0) continue;

    results.push({
      url: parsedUrl.toString(),
      title,
      image_url: null,
      price_usd: priceUsd,
      rating: null,
      review_count: null,
      prime_eligible: null,
    });
  }

  return results;
}

/**
 * Make the Google Shopping request and parse the response. Returns a
 * discriminated outcome so the caller can branch cleanly on
 * blocked vs. error vs. ok.
 */
async function scrapeGoogleShopping(
  query: string,
  siteFilter: string | null
): Promise<GoogleScrapeOutcome> {
  const q = siteFilter ? `${query} site:${siteFilter}` : query;
  const url = `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return { kind: "error", reason: errorMessage(err, "fetch failed") };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429 || response.status === 403) {
    return { kind: "blocked" };
  }
  if (!response.ok) {
    return { kind: "error", reason: `Google returned HTTP ${response.status}` };
  }

  const body = await readBodyCapped(response);
  const lower = body.toLowerCase();
  for (const sig of GOOGLE_BLOCK_SIGNATURES) {
    if (lower.includes(sig)) return { kind: "blocked" };
  }

  const results = parseGoogleShoppingHtml(body);
  if (results.length === 0) {
    // Treat "fetched fine but parsed zero rows" as a soft block — the agent
    // is better off scraping the merchant directly than receiving an empty
    // list with no clear reason.
    return { kind: "blocked" };
  }
  return { kind: "ok", results };
}

// ---------------------------------------------------------------------------
// DEV-mode simulated response
// ---------------------------------------------------------------------------

function devSimulatedResults(): NormalizedResult[] {
  return [
    {
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      title: "Sony WH-1000XM5 Wireless Industry-Leading Noise Canceling Headphones",
      image_url: "https://m.media-amazon.com/images/I/61yIzVS4r-L._AC_SL1500_.jpg",
      price_usd: 399.99,
      rating: 4.6,
      review_count: 12_000,
      prime_eligible: true,
    },
    {
      url: "https://www.amazon.com/dp/B098FKXT8L",
      title: "Bose QuietComfort 45 Bluetooth Wireless Noise Cancelling Headphones",
      image_url: "https://m.media-amazon.com/images/I/51JbVZBZTQL._AC_SL1500_.jpg",
      price_usd: 279.0,
      rating: 4.5,
      review_count: 18_400,
      prime_eligible: true,
    },
    {
      url: "https://www.amazon.com/dp/B08PZHYWJS",
      title: "Apple AirPods Max - Active Noise Cancellation Over-Ear Headphones",
      image_url: "https://m.media-amazon.com/images/I/81Wd1G3pl0L._AC_SL1500_.jpg",
      price_usd: 549.0,
      rating: 4.4,
      review_count: 9_500,
      prime_eligible: true,
    },
  ];
}

function formatDevResponse(
  merchantLabel: string,
  query: string,
  maxResults: number,
  maxPriceUsd: number | undefined
): string {
  const clamped = clampAndFilter(devSimulatedResults(), maxResults, maxPriceUsd);
  return (
    `[DEV MODE] search_products called.\n` +
    `Merchant: ${merchantLabel}  Query: "${query}"\n\n` +
    formatSearchResults(query, merchantLabel, clamped)
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSearchProductsTool(server: McpServer): void {
  server.tool(
    "search_products",
    "Searches a merchant (Amazon, eBay, Google Shopping, or any hostname) " +
    "for the top N products matching a natural-language query, optionally " +
    "filtered by max price. Use this BEFORE `fetch_product_preview` when the " +
    "user describes what they want but has not given you a specific product " +
    "URL - for example \"find me a Sony noise-cancelling headphone under " +
    "$400 on Amazon\". " +
    "If your agent already has a browser/search tool that can pull merchant " +
    "results directly, you may run the search yourself and pass the rows via " +
    "`agent_extracted.results` so this tool just validates and formats them. " +
    "Otherwise, call with merchant + query alone - for blocked merchants the " +
    "tool returns a SCRAPING BLOCKED instruction telling you to run the " +
    "search via your browser tool and re-call with agent_extracted. " +
    "Read-only: never moves money.",
    SearchProductsInput.shape,
    async (input) => {
      // Clamp max_results before any branching so DEV mode and prod both
      // honour the same ceiling.
      const requested = input.max_results ?? DEFAULT_MAX_RESULTS;
      const cap = Math.min(Math.max(1, requested), MAX_RESULTS_CAP);
      const { label: merchantLabel, siteFilter } = resolveMerchant(input.merchant);

      if (DEV_MODE) {
        return textResponse(
          formatDevResponse(merchantLabel, input.query, cap, input.max_price_usd)
        );
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      // -----------------------------------------------------------------
      // Path 1 (agent_extracted): the agent already ran the search via its
      // browser tool. Validate (already done by Zod), normalize, filter,
      // clamp, audit-log, and return.
      // -----------------------------------------------------------------
      if (input.agent_extracted !== undefined) {
        const normalized = input.agent_extracted.results.map(normalizeAgentRow);
        const clamped = clampAndFilter(normalized, cap, input.max_price_usd);

        try {
          await logTransaction({
            userId: user.id,
            service: merchantLabel,
            status: "success",
            amountUsd: 0,
            description:
              `Product search "${input.query}" on ${merchantLabel} - ` +
              `${clamped.length} agent-supplied result${clamped.length === 1 ? "" : "s"}`,
            transactionType: "product_search_via_agent",
          });
        } catch (logErr) {
          console.error(
            `[search_products] audit log write failed (agent_extracted) ` +
            `user=${user.id} merchant=${merchantLabel}: ` +
            `${errorMessage(logErr, "unknown error")}`
          );
        }

        return textResponse(formatSearchResults(input.query, merchantLabel, clamped));
      }

      // -----------------------------------------------------------------
      // Path 2 (server scrape via Google Shopping): only attempted for
      // merchants that are NOT in the known-blocked list. The blocked list
      // covers the merchants where every server-side path we've tried has
      // ended in a captcha, so a fetch round-trip would just delay the
      // SCRAPING BLOCKED handoff.
      // -----------------------------------------------------------------
      if (!merchantIsKnownBlocked(merchantLabel)) {
        const outcome = await scrapeGoogleShopping(input.query, siteFilter);
        if (outcome.kind === "ok") {
          const clamped = clampAndFilter(outcome.results, cap, input.max_price_usd);
          try {
            await logTransaction({
              userId: user.id,
              service: merchantLabel,
              status: "success",
              amountUsd: 0,
              description:
                `Product search "${input.query}" on ${merchantLabel} - ` +
                `${clamped.length} server-scraped result${clamped.length === 1 ? "" : "s"}`,
              transactionType: "product_search",
            });
          } catch (logErr) {
            console.error(
              `[search_products] audit log write failed (server_scrape) ` +
              `user=${user.id} merchant=${merchantLabel}: ` +
              `${errorMessage(logErr, "unknown error")}`
            );
          }
          return textResponse(
            formatSearchResults(input.query, merchantLabel, clamped)
          );
        }
        // Fall through to SCRAPING BLOCKED on either "blocked" or "error" —
        // the agent has a reliable alternative path (its own browser tool),
        // so we always offer that as the recovery action.
      }

      // -----------------------------------------------------------------
      // Path 3 (scraping blocked): return the structured instruction. Audit
      // log the handoff so ops can spot a merchant whose anti-bot wall
      // rolled out (or got tighter) recently.
      // -----------------------------------------------------------------
      try {
        await logTransaction({
          userId: user.id,
          service: merchantLabel,
          status: "success",
          amountUsd: 0,
          description:
            `Product search "${input.query}" on ${merchantLabel} blocked - ` +
            `agent fallback instruction returned`,
          transactionType: "product_search",
        });
      } catch (logErr) {
        console.error(
          `[search_products] audit log write failed (blocked) ` +
          `user=${user.id} merchant=${merchantLabel}: ` +
          `${errorMessage(logErr, "unknown error")}`
        );
      }

      return textResponse(
        formatScrapingBlockedInstruction(
          merchantLabel,
          input.query,
          cap,
          input.max_price_usd
        )
      );
    }
  );
}
