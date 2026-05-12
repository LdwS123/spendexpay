"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client for use in Client Components.
 * Stores the session in localStorage / cookies automatically via @supabase/ssr.
 *
 * Call this inside a Client Component or hook — not in Server Components
 * (use src/lib/supabase/server.ts there).
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
