import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import Sidebar from "./sidebar";

/**
 * Dashboard layout — Server Component.
 *
 * Auth check happens here on the server before any page content renders.
 * If there is no active session the user is redirected to /login.
 * The middleware also enforces this, but having the check here as well
 * means the redirect happens even if the middleware matcher misses a route,
 * and it gives us the authenticated user object to pass down as props.
 *
 * Onboarding: after auth, we check whether a public.users row exists for
 * this user. If not (i.e. new signup), we fire a POST to /api/onboarding
 * in the background. The request does not block rendering — the user sees
 * the dashboard immediately while the row is created asynchronously.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  // getUser() validates the JWT server-side — more reliable than getSession()
  // which only reads from the cookie without re-validating.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const email = user.email ?? "";

  // -------------------------------------------------------------------------
  // Onboarding check — fire-and-forget, must not block the render
  // -------------------------------------------------------------------------
  // We do a lightweight existence check here (single indexed primary-key
  // lookup) rather than inside the route handler, so we can avoid the
  // network round-trip on every page load for existing users.
  try {
    const admin = getAdminClient();
    const { data: userRow } = await admin
      .from("users")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (!userRow) {
      // New user — trigger onboarding in the background. We derive the
      // absolute URL from the incoming request headers so this works in
      // both local dev (http://localhost:3000) and production.
      const headersList = await headers();
      const host = headersList.get("host") ?? "localhost:3000";
      const protocol = host.startsWith("localhost") ? "http" : "https";
      const onboardingUrl = `${protocol}://${host}/api/onboarding`;

      // Fire-and-forget — attach a catch so an onboarding failure never
      // crashes the layout render. The user will see the dashboard; they
      // can generate an MCP token once onboarding completes (usually <1s).
      fetch(onboardingUrl, {
        method: "POST",
        headers: {
          // Forward the session cookie so the route handler can call
          // supabase.auth.getUser() and identify the user.
          cookie: headersList.get("cookie") ?? "",
        },
      }).catch((err) => {
        console.error("[dashboard/layout] Background onboarding request failed:", err);
      });
    }
  } catch (err) {
    // Non-fatal — log and continue. The user can still view the dashboard;
    // they'll be prompted to complete setup if needed.
    console.error("[dashboard/layout] Onboarding check failed:", err);
  }

  return (
    <div className="lg:flex min-h-screen bg-[#f6f7f9] text-[#0a1220]">
      {/* Skip-to-content — visible only when focused via keyboard. */}
      <a
        href="#dashboard-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-[#070d18] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#00e5b4] focus:ring-2 focus:ring-[#00e5b4]"
      >
        Skip to content
      </a>
      <Sidebar email={email} />
      <div id="dashboard-content" className="flex-1 min-w-0 lg:overflow-auto">
        {children}
      </div>
    </div>
  );
}
