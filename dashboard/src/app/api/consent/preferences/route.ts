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
 *
 * ─── Schema mapping ─────────────────────────────────────────────────────────
 * The dashboard UI talks in `threshold_usd`, `email_enabled`, `telegram_enabled`
 * for historical reasons, but the actual DB columns (per
 * migrations/003_consent_layer.sql) are:
 *
 *   - `auto_below_threshold_usd`    numeric         (was: threshold_usd)
 *   - `notification_channels`        jsonb (array)  (encodes email/telegram on)
 *
 * Email is always-on in v1 per product spec; the only configurable channel is
 * Telegram. We translate between the two shapes here so neither the UI nor the
 * MCP server (`src/lib/db.ts:getOrCreateConsentPreferences`) has to know about
 * the other's naming.
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

/**
 * Wire shape returned to the dashboard UI. Field names match what the UI
 * already expects (legacy names) — `threshold_usd`, `email_enabled`,
 * `telegram_enabled`.
 */
interface PreferencesWire {
  user_id: string;
  default_mode: DefaultMode | null;
  threshold_usd: number | null;
  trusted_services: string[] | null;
  telegram_chat_id: string | null;
  email_enabled: boolean | null;
  telegram_enabled: boolean | null;
  push_enabled: boolean | null;
  updated_at?: string | null;
}

/**
 * Raw DB row shape — these are the real column names from migration 003.
 */
interface PreferencesDbRow {
  user_id: string;
  default_mode: DefaultMode | null;
  auto_below_threshold_usd: number | string | null;
  trusted_services: unknown;
  notification_channels: unknown;
  telegram_chat_id: string | null;
  updated_at?: string | null;
}

interface PostBody {
  default_mode?: unknown;
  threshold_usd?: unknown;
  trusted_services?: unknown;
  telegram_chat_id?: unknown;
  telegram_enabled?: unknown;
  push_enabled?: unknown;
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

function defaults(userId: string): PreferencesWire {
  return {
    user_id: userId,
    default_mode: "always_ask",
    threshold_usd: null,
    trusted_services: null,
    telegram_chat_id: null,
    email_enabled: true,
    telegram_enabled: false,
    push_enabled: false,
  };
}

/**
 * Coerce a jsonb-shaped value into a string[]. Accepts a real array, a
 * JSON-encoded string, or null. Any unrecognized shape collapses to [].
 */
function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // fall through
    }
  }
  return [];
}

/**
 * Convert a DB row to the wire shape the dashboard UI expects.
 *
 * `notification_channels` is the source of truth for email/telegram on/off:
 *   - "email" present     → email_enabled: true   (always true in v1)
 *   - "telegram" present  → telegram_enabled: true
 */
function rowToWire(row: PreferencesDbRow): PreferencesWire {
  const channels = coerceStringArray(row.notification_channels);
  const threshold =
    row.auto_below_threshold_usd === null ||
    row.auto_below_threshold_usd === undefined
      ? null
      : typeof row.auto_below_threshold_usd === "string"
      ? Number(row.auto_below_threshold_usd)
      : row.auto_below_threshold_usd;

  return {
    user_id: row.user_id,
    default_mode: row.default_mode,
    threshold_usd: Number.isFinite(threshold) ? (threshold as number) : null,
    trusted_services: coerceStringArray(row.trusted_services),
    telegram_chat_id: row.telegram_chat_id,
    email_enabled: channels.includes("email"),
    telegram_enabled: channels.includes("telegram"),
    push_enabled: channels.includes("push"),
    updated_at: row.updated_at ?? null,
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
        "user_id, default_mode, auto_below_threshold_usd, trusted_services, " +
          "notification_channels, telegram_chat_id, updated_at"
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

    return NextResponse.json(
      rowToWire(data as unknown as PreferencesDbRow),
      { status: 200 }
    );
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

  // ── Validate threshold_usd (mapped to auto_below_threshold_usd in DB) ────
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

  // ── Validate push_enabled ────────────────────────────────────────────────
  let pushEnabled: boolean = false;
  if (body.push_enabled !== undefined) {
    if (typeof body.push_enabled !== "boolean") {
      return NextResponse.json(
        { error: "push_enabled must be a boolean" },
        { status: 400 }
      );
    }
    pushEnabled = body.push_enabled;
  }

  // ── Build notification_channels from email (always on) + telegram + push.
  // Email is always on per product spec; the other two are user toggles.
  const notificationChannels: string[] = ["email"];
  if (telegramEnabled) notificationChannels.push("telegram");
  if (pushEnabled) notificationChannels.push("push");

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
    // Payload uses REAL DB column names (per migration 003).
    const payload = {
      user_id: userId,
      default_mode: defaultMode as DefaultMode,
      auto_below_threshold_usd: thresholdUsd,
      trusted_services: trustedServices ?? [],
      notification_channels: notificationChannels,
      telegram_chat_id: telegramChatId,
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
