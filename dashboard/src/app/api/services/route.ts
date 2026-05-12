import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// ─── service whitelist ────────────────────────────────────────────────────────
//
// Hard-coded list of supported services. Each entry maps the public service
// slug (used in the API surface) to the `users` column that stores the token.
// We never accept arbitrary strings — any service the client refers to must
// appear in this table or the request is rejected.

const SERVICE_COLUMNS = {
  vercel: "vercel_token",
  netlify: "netlify_token",
  railway: "railway_token",
  fly: "fly_token",
  render: "render_token",
  replicate: "replicate_token",
  modal: "modal_token",
} as const;

type ServiceSlug = keyof typeof SERVICE_COLUMNS;
const SERVICE_SLUGS = Object.keys(SERVICE_COLUMNS) as ServiceSlug[];

function isServiceSlug(value: unknown): value is ServiceSlug {
  return typeof value === "string" && (SERVICE_SLUGS as string[]).includes(value);
}

// ─── types ────────────────────────────────────────────────────────────────────

interface UserTokensRow {
  vercel_token: string | null;
  netlify_token: string | null;
  railway_token: string | null;
  fly_token: string | null;
  render_token: string | null;
  replicate_token: string | null;
  modal_token: string | null;
}

interface PostBody {
  service: unknown;
  token: unknown;
}

interface DeleteBody {
  service: unknown;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getAuthedUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user.id;
}

// ─── GET — return connection status for every service ────────────────────────
//
// Never returns the raw token value. Only a boolean derived from "is the
// column null". The frontend uses this to render Connected / Not connected
// badges.

export async function GET(): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/services] GET: failed to create admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  try {
    const { data, error } = await admin
      .from("users")
      .select(
        "vercel_token, netlify_token, railway_token, fly_token, render_token, replicate_token, modal_token"
      )
      .eq("id", userId)
      .single();

    if (error) {
      console.error("[api/services] GET: users query error:", error);
      return NextResponse.json({ error: "Failed to fetch services" }, { status: 500 });
    }

    const row = (data ?? null) as UserTokensRow | null;

    const services: Record<ServiceSlug, { connected: boolean }> = {
      vercel: { connected: row?.vercel_token != null },
      netlify: { connected: row?.netlify_token != null },
      railway: { connected: row?.railway_token != null },
      fly: { connected: row?.fly_token != null },
      render: { connected: row?.render_token != null },
      replicate: { connected: row?.replicate_token != null },
      modal: { connected: row?.modal_token != null },
    };

    return NextResponse.json({ services }, { status: 200 });
  } catch (err) {
    console.error("[api/services] GET: unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── POST — save a service token ─────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isServiceSlug(body.service)) {
    return NextResponse.json(
      { error: "Unknown service — must be one of: " + SERVICE_SLUGS.join(", ") },
      { status: 400 }
    );
  }

  if (typeof body.token !== "string" || body.token.trim().length === 0) {
    return NextResponse.json(
      { error: "token must be a non-empty string" },
      { status: 400 }
    );
  }

  const token = body.token.trim();
  const column = SERVICE_COLUMNS[body.service];

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/services] POST: failed to create admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  try {
    const { error } = await admin
      .from("users")
      .update({ [column]: token })
      .eq("id", userId);

    if (error) {
      console.error("[api/services] POST: update error:", error);
      return NextResponse.json({ error: "Failed to save token" }, { status: 500 });
    }

    return NextResponse.json({ service: body.service, connected: true }, { status: 200 });
  } catch (err) {
    console.error("[api/services] POST: unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── DELETE — disconnect a service ───────────────────────────────────────────

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isServiceSlug(body.service)) {
    return NextResponse.json(
      { error: "Unknown service — must be one of: " + SERVICE_SLUGS.join(", ") },
      { status: 400 }
    );
  }

  const column = SERVICE_COLUMNS[body.service];

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/services] DELETE: failed to create admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  try {
    const { error } = await admin
      .from("users")
      .update({ [column]: null })
      .eq("id", userId);

    if (error) {
      console.error("[api/services] DELETE: update error:", error);
      return NextResponse.json({ error: "Failed to disconnect service" }, { status: 500 });
    }

    return NextResponse.json({ service: body.service, connected: false }, { status: 200 });
  } catch (err) {
    console.error("[api/services] DELETE: unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
