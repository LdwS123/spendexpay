import { NextResponse } from "next/server";
import { createHmac, randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// ─── helpers ──────────────────────────────────────────────────────────────────

function hashToken(raw: string): string {
  const salt = process.env.MCP_TOKEN_SALT;
  if (!salt) {
    throw new Error("MCP_TOKEN_SALT is not set — add it to .env.local");
  }
  return createHmac("sha256", salt).update(raw).digest("hex");
}

async function authedClient() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { supabase, user: null };
  return { supabase, user };
}

// ─── GET — does the current user have a token? ────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const { supabase, user } = await authedClient();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("users")
    .select("mcp_token, created_at")
    .eq("id", user.id)
    .single();

  if (error) {
    console.error("[api/tokens] GET db error:", error);
    return NextResponse.json(
      { error: "Failed to fetch token status" },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      hasToken: data?.mcp_token !== null && data?.mcp_token !== undefined,
      createdAt: data?.created_at ?? null,
    },
    { status: 200 }
  );
}

// ─── POST — generate a new token ─────────────────────────────────────────────

export async function POST(): Promise<NextResponse> {
  const { supabase, user } = await authedClient();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  // Generate raw token: spx_ + 32 random hex chars (16 bytes)
  const rawToken = "spx_" + randomBytes(16).toString("hex");

  let tokenHash: string;
  try {
    tokenHash = hashToken(rawToken);
  } catch (err) {
    console.error("[api/tokens] POST hash error:", err);
    return NextResponse.json(
      { error: "Server misconfiguration: MCP_TOKEN_SALT not set" },
      { status: 500 }
    );
  }

  const { error } = await supabase
    .from("users")
    .update({ mcp_token: tokenHash })
    .eq("id", user.id);

  if (error) {
    console.error("[api/tokens] POST db error:", error);
    return NextResponse.json(
      { error: "Failed to save token" },
      { status: 500 }
    );
  }

  // Return the raw token ONCE — it is never stored, never retrievable again.
  return NextResponse.json({ token: rawToken }, { status: 201 });
}

// ─── DELETE — revoke the token ────────────────────────────────────────────────

export async function DELETE(): Promise<NextResponse> {
  const { supabase, user } = await authedClient();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { error } = await supabase
    .from("users")
    .update({ mcp_token: null })
    .eq("id", user.id);

  if (error) {
    console.error("[api/tokens] DELETE db error:", error);
    return NextResponse.json(
      { error: "Failed to revoke token" },
      { status: 500 }
    );
  }

  return NextResponse.json({ revoked: true }, { status: 200 });
}
