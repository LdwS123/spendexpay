-- Product preview cache.
--
-- When the agent calls `fetch_product_preview`, we either scrape OpenGraph
-- meta from the URL server-side OR (when the merchant blocks bots — Amazon,
-- Walmart, Apple, …) we ask the host agent to scrape via its own browser
-- tool and re-call with `agent_extracted`. Either way the resulting product
-- snapshot is cached here for 7 days so a subsequent request for the same
-- URL returns instantly without re-scraping (and without burning the
-- agent's tokens on a second computer-use round trip).
--
-- The cache is keyed by `url_hash` (a SHA-256 hex digest of the canonical
-- URL) rather than the raw URL. Two reasons:
--   - storage: a hash is a fixed 64 chars vs. arbitrary-length URLs that can
--     run into thousands of bytes with tracking params.
--   - index size: a btree on a 64-char column is much smaller than one on
--     a free-form text column, which matters once we have millions of rows.
--
-- The `source` column lets ops tell at a glance which path produced the
-- preview — useful when investigating why a particular merchant is
-- frequently going through the agent fallback (anti-bot signature changed,
-- new merchant added, etc.).

create table if not exists product_previews (
  id uuid primary key default uuid_generate_v4(),
  url text not null,
  url_hash text not null,
  title text,
  image_url text,
  description text,
  price numeric(10, 2),
  currency text,
  site_name text,
  source text check (source in ('server_fetch', 'agent_extracted')) not null,
  created_at timestamptz not null default now(),
  ttl_expires_at timestamptz not null default (now() + interval '7 days')
);

-- Hot-path lookup: "give me the freshest non-expired row for this URL".
-- The descending order on ttl_expires_at lets us LIMIT 1 cheaply when
-- multiple cache entries exist for the same URL (e.g. a fresh scrape was
-- written before a stale row was evicted by a TTL sweep).
create index if not exists idx_product_previews_url_hash
  on product_previews (url_hash, ttl_expires_at desc);
