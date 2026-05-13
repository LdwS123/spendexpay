import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js middleware — runs on every matched request before the page renders.
 *
 * Responsibilities:
 *  1. Refresh the Supabase session (required by @supabase/ssr so that
 *     short-lived JWTs are rotated without a full page reload).
 *  2. Redirect unauthenticated visitors away from /dashboard/* to /login.
 *  3. Redirect authenticated visitors away from /login to /dashboard.
 */
export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write cookies onto the request so downstream middleware can see them.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          // Also write onto the response so the browser stores them.
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do not add any logic between createServerClient and getUser().
  // A subtle bug in @supabase/ssr can cause sessions to not be refreshed if
  // anything interrupts the cookie sync that happens inside getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // ── Legacy URL redirects ────────────────────────────────────────────────
  // The dashboard navigation was condensed from 9 items to 5. The legacy
  // pages themselves still exist (deep links, bookmarks, in-product
  // emails), but the canonical V1 surface is now /dashboard/activity for
  // every charge & order. Honour the old transactions URL with a redirect
  // so saved links keep working.
  if (pathname === "/dashboard/transactions") {
    const next = request.nextUrl.clone();
    next.pathname = "/dashboard/activity";
    // request.nextUrl.clone() already preserves searchParams.
    return NextResponse.redirect(next);
  }

  // Unauthenticated user trying to access a protected route → send to /login.
  if (!user && pathname.startsWith("/dashboard")) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  // Authenticated user hitting /login → send them to the dashboard.
  if (user && pathname === "/login") {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/dashboard";
    return NextResponse.redirect(dashboardUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     *  - _next/static  (static files)
     *  - _next/image   (image optimisation)
     *  - favicon.ico   (browser favicon)
     *  - api/webhooks  (Stripe webhooks — must not be blocked by auth)
     */
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks).*)",
  ],
};
