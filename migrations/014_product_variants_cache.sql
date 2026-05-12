-- Product variants cache.
--
-- `fetch_product_preview` (migration 009) caches the basic title/image/price
-- snapshot for a product URL. That's enough for a one-SKU consent prompt
-- ("approve $399 on Amazon for Sony WH-1000XM5?") but it does NOT capture
-- the variant axis that real listings carry: color, size, storage, model,
-- configuration. To reproduce a complete shopping experience the agent
-- needs to know that the Sony WH-1000XM5 is sold in 3 colors, that the
-- iPhone 15 is sold in 6 storage tiers with $50 increments, that the
-- T-shirt is sold in S/M/L/XL/XXL, etc.
--
-- This table backs `get_product_variants` — same dual-source pattern as the
-- preview cache: a row is written either by a server-side scrape that
-- successfully parsed JSON-LD `<script type="application/ld+json">`
-- schema.org Product/Offer trees, OR by the host agent's browser tool
-- after we returned a SCRAPING BLOCKED instruction for a merchant that
-- swaps in a decoy page (Amazon, Walmart, Apple, …).
--
-- Variants are stored as a single JSONB array rather than a normalised
-- table because the schema is genuinely heterogeneous across merchants —
-- some products have one axis (color), some have three (color + size +
-- storage), the price deltas can be per-axis or only on one axis, and the
-- per-variant image URLs are optional. Forcing every row into a join would
-- give us less type safety than a discriminated JSONB blob and would force
-- every read to fan out to N small queries.
--
-- The 7-day TTL matches the preview cache so a single consent flow that
-- fetches preview + variants reuses both rows or refreshes them together.

create table if not exists product_variants (
  id uuid primary key default uuid_generate_v4(),
  url text not null,
  url_hash text not null,
  -- Array of {axis, name, value, price_delta_usd?, available, image_url?}
  -- See src/lib/db.ts ProductVariantOption for the canonical TypeScript shape.
  variants jsonb not null,
  base_price_usd numeric(10, 2),
  currency text,
  min_quantity int default 1,
  max_quantity int default 99,
  source text check (source in ('server_fetch', 'agent_extracted')) not null,
  created_at timestamptz not null default now(),
  ttl_expires_at timestamptz not null default (now() + interval '7 days')
);

-- Hot-path lookup: "give me the freshest non-expired variants row for
-- this URL". Mirrors the index strategy on product_previews so the two
-- caches behave identically at read time.
create index if not exists idx_product_variants_url_hash
  on product_variants (url_hash, ttl_expires_at desc);
