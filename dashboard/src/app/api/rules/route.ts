import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// ─── types ────────────────────────────────────────────────────────────────────

interface RuleRow {
  id: string;
  user_id: string;
  rule_type: string;
  params: Record<string, unknown>;
  active: boolean;
  created_at: string;
}

interface UserRow {
  id: string;
  max_auto_charge_usd: number | null;
}

interface PostBody {
  max_auto_charge_usd: number;
  monthly_budget: number;
  allowed_services: string[] | null;
  // Merchant name substrings to block even within allowed MCC categories.
  // Optional in the request body — older clients that don't send this field
  // will simply leave the existing rule untouched (no-op deactivate+nothing).
  blocked_services?: string[] | null;
  // Per-service caps (use case V2 #5.2). Each entry binds a single service
  // to its own monthly / per-transaction cap and / or a hard block. Empty
  // array or undefined → clear any existing per-service rules for this
  // user. Missing fields on an entry are treated as "no cap on that axis".
  per_service_limits?: PerServiceLimit[];
  // Smart rules (migration 016). All four fields are optional so a legacy
  // client that doesn't send them leaves the existing rows alone (no-op
  // deactivate+nothing). Server-side validation is the same shape used by
  // the runtime rules evaluator in src/lib/db.ts.
  category_blocklist?: string[] | null;
  category_caps?: Record<string, number> | null;
  risk_threshold?: number | null;
  urgency_requires_consent?: boolean | null;
}

interface PerServiceLimit {
  service: string;
  monthly_cap_usd?: number | null;
  per_tx_cap_usd?: number | null;
  blocked?: boolean;
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

// ─── GET — fetch current rules ────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/rules] GET: failed to create admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  try {
    // Fetch max_auto_charge_usd from users table
    const { data: userData, error: userError } = await admin
      .from("users")
      .select("id, max_auto_charge_usd")
      .eq("id", userId)
      .single();

    if (userError) {
      console.error("[api/rules] GET: users query error:", userError);
      return NextResponse.json({ error: "Failed to fetch user settings" }, { status: 500 });
    }

    const user = userData as UserRow | null;

    // Fetch all active rules for this user
    const { data: rulesData, error: rulesError } = await admin
      .from("rules")
      .select("id, user_id, rule_type, params, active, created_at")
      .eq("user_id", userId)
      .eq("active", true);

    if (rulesError) {
      console.error("[api/rules] GET: rules query error:", rulesError);
      return NextResponse.json({ error: "Failed to fetch rules" }, { status: 500 });
    }

    const rules: RuleRow[] = (rulesData ?? []) as RuleRow[];

    // Extract well-known rule values from rules array
    const monthlyRule = rules.find((r) => r.rule_type === "max_amount_per_month");
    const allowedServicesRule = rules.find((r) => r.rule_type === "allowed_services");
    const blockedServicesRule = rules.find((r) => r.rule_type === "blocked_services");

    // ── Per-service rules ────────────────────────────────────────────────
    // Per-service caps live as one row per axis (monthly cap, per-tx cap,
    // blocked flag) keyed by params.service. Collapse them into one entry
    // per service so the dashboard can render a single line per merchant.
    const perServiceMap = new Map<string, PerServiceLimit>();
    function upsertPerService(service: string): PerServiceLimit {
      const existing = perServiceMap.get(service);
      if (existing) return existing;
      const fresh: PerServiceLimit = { service };
      perServiceMap.set(service, fresh);
      return fresh;
    }
    for (const r of rules) {
      if (
        r.rule_type !== "per_service_monthly_cap" &&
        r.rule_type !== "per_service_per_tx_cap"
      ) {
        continue;
      }
      const service = r.params?.service;
      if (typeof service !== "string" || service.length === 0) continue;
      const entry = upsertPerService(service);
      if (r.rule_type === "per_service_monthly_cap" && typeof r.params?.monthly_cap_usd === "number") {
        entry.monthly_cap_usd = r.params.monthly_cap_usd;
      }
      if (r.rule_type === "per_service_per_tx_cap" && typeof r.params?.per_tx_cap_usd === "number") {
        entry.per_tx_cap_usd = r.params.per_tx_cap_usd;
      }
      if (r.params?.blocked === true) {
        entry.blocked = true;
      }
    }

    // ── Smart rules (migration 016) ──────────────────────────────────────
    // Surface the four new rule types so the dashboard "Smart rules"
    // section can render their current values. Each field collapses one
    // or more rows in the rules table.
    const categoryBlocklistRule = rules.find((r) => r.rule_type === "category_blocklist");
    const riskThresholdRule = rules.find((r) => r.rule_type === "risk_threshold");
    const urgencyConsentRule = rules.find((r) => r.rule_type === "urgency_requires_consent");
    const categoryCaps: Record<string, number> = {};
    for (const r of rules) {
      if (r.rule_type !== "category_max_per_month") continue;
      const category = r.params?.category;
      const usd = r.params?.usd;
      if (typeof category !== "string" || typeof usd !== "number") continue;
      categoryCaps[category.toLowerCase()] = usd;
    }

    return NextResponse.json(
      {
        max_auto_charge_usd: user?.max_auto_charge_usd ?? 0,
        monthly_budget: (monthlyRule?.params?.usd as number) ?? null,
        allowed_services: (allowedServicesRule?.params?.services as string[]) ?? null,
        blocked_services: (blockedServicesRule?.params?.services as string[]) ?? null,
        per_service_limits: Array.from(perServiceMap.values()),
        category_blocklist:
          (categoryBlocklistRule?.params?.categories as string[] | undefined) ?? null,
        category_caps: Object.keys(categoryCaps).length > 0 ? categoryCaps : null,
        risk_threshold:
          typeof riskThresholdRule?.params?.threshold === "number"
            ? (riskThresholdRule.params.threshold as number)
            : null,
        urgency_requires_consent: urgencyConsentRule?.params?.enabled === true,
        rules,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[api/rules] GET: unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── POST — upsert rules ──────────────────────────────────────────────────────

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

  const { max_auto_charge_usd, monthly_budget, allowed_services } = body;
  const blocked_services = body.blocked_services ?? null;
  const per_service_limits = body.per_service_limits ?? [];

  // Basic validation
  if (typeof max_auto_charge_usd !== "number" || max_auto_charge_usd < 0) {
    return NextResponse.json(
      { error: "max_auto_charge_usd must be a non-negative number" },
      { status: 400 }
    );
  }
  if (typeof monthly_budget !== "number" || monthly_budget < 0) {
    return NextResponse.json(
      { error: "monthly_budget must be a non-negative number" },
      { status: 400 }
    );
  }
  if (
    allowed_services !== null &&
    (!Array.isArray(allowed_services) ||
      allowed_services.some((s) => typeof s !== "string"))
  ) {
    return NextResponse.json(
      { error: "allowed_services must be an array of strings or null" },
      { status: 400 }
    );
  }
  if (
    blocked_services !== null &&
    (!Array.isArray(blocked_services) ||
      blocked_services.some((s) => typeof s !== "string"))
  ) {
    return NextResponse.json(
      { error: "blocked_services must be an array of strings or null" },
      { status: 400 }
    );
  }
  if (!Array.isArray(per_service_limits)) {
    return NextResponse.json(
      { error: "per_service_limits must be an array (use [] to clear)" },
      { status: 400 }
    );
  }
  // Validate each entry up front so a malformed row doesn't get half-applied.
  for (const entry of per_service_limits) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.service !== "string" ||
      entry.service.length === 0
    ) {
      return NextResponse.json(
        { error: "per_service_limits[].service is required and must be a non-empty string" },
        { status: 400 }
      );
    }
    if (
      entry.monthly_cap_usd !== undefined &&
      entry.monthly_cap_usd !== null &&
      (typeof entry.monthly_cap_usd !== "number" || entry.monthly_cap_usd < 0)
    ) {
      return NextResponse.json(
        { error: `per_service_limits["${entry.service}"].monthly_cap_usd must be a non-negative number` },
        { status: 400 }
      );
    }
    if (
      entry.per_tx_cap_usd !== undefined &&
      entry.per_tx_cap_usd !== null &&
      (typeof entry.per_tx_cap_usd !== "number" || entry.per_tx_cap_usd < 0)
    ) {
      return NextResponse.json(
        { error: `per_service_limits["${entry.service}"].per_tx_cap_usd must be a non-negative number` },
        { status: 400 }
      );
    }
    if (entry.blocked !== undefined && typeof entry.blocked !== "boolean") {
      return NextResponse.json(
        { error: `per_service_limits["${entry.service}"].blocked must be a boolean` },
        { status: 400 }
      );
    }
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/rules] POST: failed to create admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  try {
    // 1. Update max_auto_charge_usd on users table
    const { error: userUpdateError } = await admin
      .from("users")
      .update({ max_auto_charge_usd })
      .eq("id", userId);

    if (userUpdateError) {
      console.error("[api/rules] POST: users update error:", userUpdateError);
      return NextResponse.json({ error: "Failed to update auto-approve limit" }, { status: 500 });
    }

    // 2. Upsert max_amount_per_month rule
    //    Supabase upsert with onConflict requires a unique constraint.
    //    We match on (user_id, rule_type) by first deactivating old rows and inserting fresh.
    const { error: deactivateMonthlyError } = await admin
      .from("rules")
      .update({ active: false })
      .eq("user_id", userId)
      .eq("rule_type", "max_amount_per_month");

    if (deactivateMonthlyError) {
      console.error("[api/rules] POST: deactivate monthly rule error:", deactivateMonthlyError);
      return NextResponse.json({ error: "Failed to update monthly budget rule" }, { status: 500 });
    }

    const { error: insertMonthlyError } = await admin.from("rules").insert({
      user_id: userId,
      rule_type: "max_amount_per_month",
      params: { usd: monthly_budget },
      active: true,
    });

    if (insertMonthlyError) {
      console.error("[api/rules] POST: insert monthly rule error:", insertMonthlyError);
      return NextResponse.json({ error: "Failed to save monthly budget rule" }, { status: 500 });
    }

    // 3. Upsert allowed_services rule (deactivate old, insert new if provided)
    const { error: deactivateServicesError } = await admin
      .from("rules")
      .update({ active: false })
      .eq("user_id", userId)
      .eq("rule_type", "allowed_services");

    if (deactivateServicesError) {
      console.error(
        "[api/rules] POST: deactivate allowed_services rule error:",
        deactivateServicesError
      );
      return NextResponse.json(
        { error: "Failed to update allowed services rule" },
        { status: 500 }
      );
    }

    if (allowed_services !== null && allowed_services.length > 0) {
      const { error: insertServicesError } = await admin.from("rules").insert({
        user_id: userId,
        rule_type: "allowed_services",
        params: { services: allowed_services },
        active: true,
      });

      if (insertServicesError) {
        console.error("[api/rules] POST: insert allowed_services rule error:", insertServicesError);
        return NextResponse.json(
          { error: "Failed to save allowed services rule" },
          { status: 500 }
        );
      }
    }

    // 4. Upsert blocked_services rule (merchant-exclusion list, takes priority
    //    over allowed MCC categories). Same deactivate-then-insert pattern as
    //    above for parity until the rules table grows a unique constraint on
    //    (user_id, rule_type) that supports real upserts.
    const { error: deactivateBlockedError } = await admin
      .from("rules")
      .update({ active: false })
      .eq("user_id", userId)
      .eq("rule_type", "blocked_services");

    if (deactivateBlockedError) {
      console.error(
        "[api/rules] POST: deactivate blocked_services rule error:",
        deactivateBlockedError
      );
      return NextResponse.json(
        { error: "Failed to update merchant exclusions" },
        { status: 500 }
      );
    }

    if (blocked_services !== null && blocked_services.length > 0) {
      const { error: insertBlockedError } = await admin.from("rules").insert({
        user_id: userId,
        rule_type: "blocked_services",
        params: { services: blocked_services },
        active: true,
      });

      if (insertBlockedError) {
        console.error("[api/rules] POST: insert blocked_services rule error:", insertBlockedError);
        return NextResponse.json(
          { error: "Failed to save merchant exclusions" },
          { status: 500 }
        );
      }
    }

    // 5. Per-service caps (use case V2 #5.2).
    //    Same deactivate-then-insert pattern as the other rule types so a
    //    repeated POST with the same payload is idempotent. We deactivate
    //    ALL per-service rows for this user, then insert one row per
    //    (service, axis) tuple that the caller wants active. This means a
    //    payload with `per_service_limits: []` clears every existing entry.
    const { error: deactivatePerServiceError } = await admin
      .from("rules")
      .update({ active: false })
      .eq("user_id", userId)
      .in("rule_type", ["per_service_monthly_cap", "per_service_per_tx_cap"]);

    if (deactivatePerServiceError) {
      console.error(
        "[api/rules] POST: deactivate per_service rules error:",
        deactivatePerServiceError
      );
      return NextResponse.json(
        { error: "Failed to update per-service caps" },
        { status: 500 }
      );
    }

    if (per_service_limits.length > 0) {
      // Build one or two rows per entry. We split per-tx and monthly into
      // separate rule_type rows so the partial index on params->>'service'
      // (migration 008) can be used by the rules-evaluation hot path.
      type RuleInsert = {
        user_id: string;
        rule_type: "per_service_monthly_cap" | "per_service_per_tx_cap";
        params: Record<string, unknown>;
        active: boolean;
      };
      const rowsToInsert: RuleInsert[] = [];
      for (const entry of per_service_limits) {
        const serviceLower = entry.service.toLowerCase();
        const hasMonthly =
          entry.monthly_cap_usd !== undefined && entry.monthly_cap_usd !== null;
        const hasPerTx =
          entry.per_tx_cap_usd !== undefined && entry.per_tx_cap_usd !== null;
        const blocked = entry.blocked === true;

        if (hasMonthly || blocked) {
          rowsToInsert.push({
            user_id: userId,
            rule_type: "per_service_monthly_cap",
            params: {
              service: serviceLower,
              ...(hasMonthly ? { monthly_cap_usd: entry.monthly_cap_usd } : {}),
              ...(blocked ? { blocked: true } : {}),
            },
            active: true,
          });
        }
        if (hasPerTx) {
          rowsToInsert.push({
            user_id: userId,
            rule_type: "per_service_per_tx_cap",
            params: {
              service: serviceLower,
              per_tx_cap_usd: entry.per_tx_cap_usd,
              ...(blocked ? { blocked: true } : {}),
            },
            active: true,
          });
        }
        // If the entry has neither caps nor a block flag we skip it — there
        // is nothing actionable to persist. The deactivate step above
        // already cleared any previous entry for this service.
      }

      if (rowsToInsert.length > 0) {
        const { error: insertPerServiceError } = await admin
          .from("rules")
          .insert(rowsToInsert);
        if (insertPerServiceError) {
          console.error(
            "[api/rules] POST: insert per_service rules error:",
            insertPerServiceError
          );
          return NextResponse.json(
            { error: "Failed to save per-service caps" },
            { status: 500 }
          );
        }
      }
    }

    // 6. Smart rules (migration 016). Same deactivate-then-insert pattern
    //    used by the other rule types. Smart-rule fields are OPT-IN — a
    //    POST without them is a no-op for that field (we still deactivate
    //    any existing rows so a payload with `null` does clear them).

    // category_blocklist
    if (body.category_blocklist !== undefined) {
      const blocklist = body.category_blocklist;
      const validBlocklist =
        blocklist === null
          ? null
          : Array.isArray(blocklist) && blocklist.every((c) => typeof c === "string")
            ? blocklist
            : undefined;
      if (validBlocklist === undefined) {
        return NextResponse.json(
          { error: "category_blocklist must be an array of strings or null" },
          { status: 400 }
        );
      }

      const { error: deactivateErr } = await admin
        .from("rules")
        .update({ active: false })
        .eq("user_id", userId)
        .eq("rule_type", "category_blocklist");
      if (deactivateErr) {
        console.error("[api/rules] POST: deactivate category_blocklist error:", deactivateErr);
        return NextResponse.json({ error: "Failed to update category blocklist" }, { status: 500 });
      }
      if (validBlocklist !== null && validBlocklist.length > 0) {
        const { error: insertErr } = await admin.from("rules").insert({
          user_id: userId,
          rule_type: "category_blocklist",
          params: { categories: validBlocklist.map((c) => c.toLowerCase()) },
          active: true,
        });
        if (insertErr) {
          console.error("[api/rules] POST: insert category_blocklist error:", insertErr);
          return NextResponse.json({ error: "Failed to save category blocklist" }, { status: 500 });
        }
      }
    }

    // category_caps (one row per category with a non-empty cap)
    if (body.category_caps !== undefined) {
      const caps = body.category_caps;
      if (
        caps !== null &&
        (typeof caps !== "object" ||
          Object.values(caps).some((v) => typeof v !== "number" || v < 0))
      ) {
        return NextResponse.json(
          { error: "category_caps must be a {category: number} map or null" },
          { status: 400 }
        );
      }

      const { error: deactivateErr } = await admin
        .from("rules")
        .update({ active: false })
        .eq("user_id", userId)
        .eq("rule_type", "category_max_per_month");
      if (deactivateErr) {
        console.error("[api/rules] POST: deactivate category_caps error:", deactivateErr);
        return NextResponse.json({ error: "Failed to update category caps" }, { status: 500 });
      }

      if (caps !== null) {
        type CategoryCapInsert = {
          user_id: string;
          rule_type: "category_max_per_month";
          params: { category: string; usd: number };
          active: boolean;
        };
        const rows: CategoryCapInsert[] = [];
        for (const [category, usd] of Object.entries(caps)) {
          if (typeof usd !== "number" || usd <= 0) continue;
          rows.push({
            user_id: userId,
            rule_type: "category_max_per_month",
            params: { category: category.toLowerCase(), usd },
            active: true,
          });
        }
        if (rows.length > 0) {
          const { error: insertErr } = await admin.from("rules").insert(rows);
          if (insertErr) {
            console.error("[api/rules] POST: insert category_caps error:", insertErr);
            return NextResponse.json({ error: "Failed to save category caps" }, { status: 500 });
          }
        }
      }
    }

    // risk_threshold (single integer 0-100; null clears the rule)
    if (body.risk_threshold !== undefined) {
      const threshold = body.risk_threshold;
      if (
        threshold !== null &&
        (typeof threshold !== "number" || threshold < 0 || threshold > 100)
      ) {
        return NextResponse.json(
          { error: "risk_threshold must be a number 0-100 or null" },
          { status: 400 }
        );
      }
      const { error: deactivateErr } = await admin
        .from("rules")
        .update({ active: false })
        .eq("user_id", userId)
        .eq("rule_type", "risk_threshold");
      if (deactivateErr) {
        console.error("[api/rules] POST: deactivate risk_threshold error:", deactivateErr);
        return NextResponse.json({ error: "Failed to update risk threshold" }, { status: 500 });
      }
      if (threshold !== null) {
        const { error: insertErr } = await admin.from("rules").insert({
          user_id: userId,
          rule_type: "risk_threshold",
          params: { threshold: Math.round(threshold) },
          active: true,
        });
        if (insertErr) {
          console.error("[api/rules] POST: insert risk_threshold error:", insertErr);
          return NextResponse.json({ error: "Failed to save risk threshold" }, { status: 500 });
        }
      }
    }

    // urgency_requires_consent (boolean toggle, no params)
    if (body.urgency_requires_consent !== undefined) {
      const enabled = body.urgency_requires_consent;
      if (enabled !== null && typeof enabled !== "boolean") {
        return NextResponse.json(
          { error: "urgency_requires_consent must be a boolean or null" },
          { status: 400 }
        );
      }
      const { error: deactivateErr } = await admin
        .from("rules")
        .update({ active: false })
        .eq("user_id", userId)
        .eq("rule_type", "urgency_requires_consent");
      if (deactivateErr) {
        console.error("[api/rules] POST: deactivate urgency_requires_consent error:", deactivateErr);
        return NextResponse.json({ error: "Failed to update urgency consent rule" }, { status: 500 });
      }
      if (enabled === true) {
        const { error: insertErr } = await admin.from("rules").insert({
          user_id: userId,
          rule_type: "urgency_requires_consent",
          params: { enabled: true },
          active: true,
        });
        if (insertErr) {
          console.error("[api/rules] POST: insert urgency_requires_consent error:", insertErr);
          return NextResponse.json({ error: "Failed to save urgency consent rule" }, { status: 500 });
        }
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error("[api/rules] POST: unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
