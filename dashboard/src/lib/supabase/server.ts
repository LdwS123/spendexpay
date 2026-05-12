import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client for use in Server Components and Route Handlers.
 * Reads and writes auth cookies via next/headers so the session is available
 * on every request without the browser needing to do anything extra.
 *
 * Must be called inside a Server Component or Route Handler — it will throw
 * if called from a Client Component (use src/lib/supabase/client.ts instead).
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll is called from Server Components where setting cookies is
            // not possible. The middleware handles cookie mutation instead.
          }
        },
      },
    }
  );
}
