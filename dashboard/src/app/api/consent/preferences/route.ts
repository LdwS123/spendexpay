import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Consent preferences API.
 *
 * GET  → returns the user's current consent preferences (or null defaults if
 *        no row exists yet, or 503-shaped empty defaults if the table isn't
 *        migrated yet).
 * POST → upserts the user's row.
 *
 * The row lives in `user_consent_preferences` and is keyed by `user_id`.
 */

// ─── types ────────────────────────────────────────────────────────────────────

type DefaultMode =
  | "always_ask"
  | "auto_below_threshold"
  | "auto_for_trusted_services"
  | "never_auto";

const VALID_MODES: ReadonlyArray<DefaultMode> = [
  "always_ask",
  "auto_below_threshold",
  "auto_for_trusted_services",
  "never_auto",
];

interface PreferencesRow {
  user_id: string;
  default_mode: DefaultMode | null;
  threshold_usd: number | null;
  trusted_services: string[] | null;
  telegram_chat_id: string | null;
  email_enabled: boolean | null;
  telegram_enabled: boolean | null;
  updated_at?: string | null;
}

interface PostBody {
  default_mode?: unknown;
  threshold_usd?: unknown;
  trusted_services?: unknown;
  telegram_chat_id?: unknown;
  telegram_enabled?: unknown;
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

function defaults(userId: string): PreferencesRow {
  return {
    user_id: userId,
    default_mode: "always_ask",
    threshold_usd: null,
    trusted_services: null,
    telegram_chat_id: null,
    email_enabled: true,
    telegram_enabled: false,
  };
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/consent/preferences] GET admin error:", err);
    return NextResponse.json(defaults(userId), { status: 200 });
  }

  try {
    const { data, error } = await admin
      .from("user_consent_preferences")
      .select(
        "user_id, default_mode, threshold_usd, trusted_services, telegram_chat_id, email_enabled, telegram_enabled, updated_at"
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      if (error.code === "42P01") {
        // Table not migrated yet — return safe defaults so the UI can render.
        return NextResponse.json(
          { ...defaults(userId), table_missing: true },
          { status: 200 }
        );
      }
      console.error("[api/consent/preferences] GET query error:", error);
      return NextResponse.json(
        { error: "Failed to load preferences" },
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json(defaults(userId), { status: 200 });
    }

    return NextResponse.json(data as PreferencesRow, { status: 200 });
  } catch (err) {
    console.error("[api/consent/preferences] GET unexpected:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────────

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

  // ── Validate default_mode ────────────────────────────────────────────────
  const defaultMode = body.default_mode;
  if (
    typeof defaultMode !== "string" ||
    !VALID_MODES.includes(defaultMode as DefaultMode)
  ) {
    return NextResponse.json(
      {
        error: `default_mode must be one of: ${VALID_MODES.join(", ")}`,
      },
      { status: 400 }
    );
  }

  // ── Validate threshold_usd ───────────────────────────────────────────────
  let thresholdUsd: number | null = null;
  if (body.threshold_usd !== undefined && body.threshold_usd !== null) {
    if (
      typeof body.threshold_usd !== "number" ||
      !Number.isFinite(body.threshold_usd) ||
      body.threshold_usd < 0
    ) {
      return NextResponse.json(
        { error: "threshold_usd must be a non-negative number" },
        { status: 400 }
      );
    }
    thresholdUsd = body.threshold_usd;
  }

  // ── Validate trusted_services ────────────────────────────────────────────
  let trustedServices: string[] | null = null;
  if (body.trusted_services !== undefined && body.trusted_services !== null) {
    if (
      !Array.isArray(body.trusted_services) ||
      body.trusted_services.some((s) => typeof s !== "string")
    ) {
      return NextResponse.json(
        { error: "trusted_services must be an array of strings" },
        { status: 400 }
      );
    }
    trustedServices = body.trusted_services as string[];
  }

  // ── Validate telegram_chat_id ────────────────────────────────────────────
  let telegramChatId: string | null = null;
  if (body.telegram_chat_id !== undefined && body.telegram_chat_id !== null) {
    if (typeof body.telegram_chat_id !== "string") {
      return NextResponse.json(
        { error: "telegram_chat_id must be a string" },
        { status: 400 }
      );
    }
    telegramChatId = body.telegram_chat_id.trim() || null;
  }

  // ── Validate telegram_enabled ────────────────────────────────────────────
  let telegramEnabled: boolean = false;
  if (body.telegram_enabled !== undefined) {
    if (typeof body.telegram_enabled !== "boolean") {
      return NextResponse.json(
        { error: "telegram_enabled must be a boolean" },
        { status: 400 }
      );
    }
    telegramEnabled = body.telegram_enabled;
  }

  // ── Upsert ───────────────────────────────────────────────────────────────
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/consent/preferences] POST admin error:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  try {
    const payload: PreferencesRow = {
      user_id: userId,
      default_mode: defaultMode as DefaultMode,
      threshold_usd: thresholdUsd,
      trusted_services: trustedServices,
      telegram_chat_id: telegramChatId,
      email_enabled: true, // Email is always on per product spec.
      telegram_enabled: telegramEnabled,
    };

    const { error } = await admin
      .from("user_consent_preferences")
      .upsert(payload, { onConflict: "user_id" });

    if (error) {
      if (error.code === "42P01") {
        return NextResponse.json(
          {
            error:
              "Consent preferences are not enabled on this account yet. Please contact support.",
          },
          { status: 503 }
        );
      }
      console.error("[api/consent/preferences] POST upsert error:", error);
      return NextResponse.json(
        { error: "Failed to save preferences" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error("[api/consent/preferences] POST unexpected:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
