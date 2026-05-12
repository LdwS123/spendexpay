import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/auth/signout
 *
 * Signs the current user out by invalidating their Supabase session and
 * clearing auth cookies, then redirects to /login.
 *
 * The sidebar's "Sign out" button calls supabase.auth.signOut() directly
 * from the browser client for instant feedback, but this route handler is
 * available for server-initiated sign-out flows (e.g. admin action, forced
 * logout after a billing anomaly).
 */
export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(
    new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
    { status: 303 }
  );
}
