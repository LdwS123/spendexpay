import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { require2FA } from "@/lib/require-2fa";

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

// ─── POST — rotate the user's MCP token ──────────────────────────────────────
//
// Auth: Supabase session (cookie-based) via `getUser()`. The previously
// trusted `x-spendex-user-id` header and body `userId` were trivially
// spoofable — both have been removed. The user's id is now derived
// exclusively from the verified session.
//
// Storage: the new raw token is HMAC-SHA256 hashed with MCP_TOKEN_SALT
// before being written to `users.mcp_token`. The raw token is returned
// once in the response — this is the only moment the user can capture it.

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { supabase, user } = await authedClient();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  // Rotating the MCP token invalidates every agent's current credential.
  // Gate it behind 2FA when enabled so a session-hijack can't lock the
  // user out of their own agents.
  const gate = await require2FA(user.id, req);
  if (gate.blocked) return gate.response;

  // Generate raw token: spx_ + 32 random hex chars (16 bytes)
  const rawToken = "spx_" + randomBytes(16).toString("hex");

  let tokenHash: string;
  try {
    tokenHash = hashToken(rawToken);
  } catch (err) {
    console.error("[api/tokens/rotate] Hash error:", err);
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
    console.error("[api/tokens/rotate] DB update error:", error);
    return NextResponse.json(
      { error: "Failed to rotate token. Try again." },
      { status: 500 }
    );
  }

  // Audit log — NEVER include the raw token or its hash.
  console.error(
    `[api/tokens/rotate] User ${user.id} rotated token at ${new Date().toISOString()}`
  );

  // Return the raw token ONCE — never stored in plaintext, never retrievable again.
  return NextResponse.json({ token: rawToken }, { status: 200 });
}
