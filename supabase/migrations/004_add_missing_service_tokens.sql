-- Add the service token columns that exist in the MCP server code but were
-- never added to the schema. All nullable; users set them via the dashboard.

alter table users
  add column if not exists huggingface_token text,
  add column if not exists gamma_api_key text,
  add column if not exists cloudflare_token text,
  add column if not exists cloudflare_account_id text,
  add column if not exists supabase_user_token text;
