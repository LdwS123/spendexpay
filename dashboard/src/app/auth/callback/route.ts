import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * OAuth callback handler.
 *
 * Supabase OAuth (GitHub, Google, etc.) sends the user back to this URL with
 * `?code=...` after they authorize on the provider. We exchange that code
 * for a session on the server so the auth cookies are set HTTP-only and the
 * next request to `/dashboard` sees an authenticated user.
 *
 * `next` lets us preserve a deep-link the user was trying to reach before
 * being bounced to login. Defaults to /dashboard.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/dashboard";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const safe = encodeURIComponent(error.message.slice(0, 200));
    return NextResponse.redirect(new URL(`/login?error=${safe}`, url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
