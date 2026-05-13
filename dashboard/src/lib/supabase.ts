import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Supabase clients are built lazily. Next.js eagerly loads every server
// module during the "Collecting page data" build phase, so a top-level
// `createClient(process.env.X!, process.env.Y!)` would crash the entire
// build the moment one env var was missing on Vercel. Gating construction
// behind a function call lets the build phase succeed; only callers that
// actually need a client pay the cost — and they fail loudly with a useful
// message if the env is incomplete.

let cachedBrowserClient: SupabaseClient | null = null;

function makeBrowserClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Add them to .env.local — see .env.example."
    );
  }
  return createClient(url, anonKey);
}

// Proxy preserves the existing API (`browserClient.auth.signOut()`) while
// deferring the real createClient() call until the first property access.
export const browserClient: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    if (!cachedBrowserClient) cachedBrowserClient = makeBrowserClient();
    return Reflect.get(cachedBrowserClient, prop, receiver);
  },
});

export function getAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set.");
  }
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local — see .env.example."
    );
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
