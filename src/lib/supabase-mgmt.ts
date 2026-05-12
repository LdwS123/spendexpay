// Supabase Management API wrapper.
//
// NOT to be confused with src/lib/db.ts, which is the Spendex Pay backend
// Supabase client (our own DB). This module talks to api.supabase.com on the
// END USER'S behalf to provision Postgres projects in their Supabase
// organization. Each user generates a personal access token at
// supabase.com/dashboard/account/tokens and pastes it into their Spendex
// dashboard once during onboarding.
//
// SECURITY: The user's dbPassword is forwarded to Supabase in the create call
// and then dropped. It is NEVER logged, stored, or returned anywhere in this
// module. Spendex's `users` table has no column for it.

import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const SUPABASE_MGMT_API_BASE = "https://api.supabase.com";

interface CreateSupabaseProjectParams {
  name: string;
  organizationId: string;
  plan: "free" | "pro";
  region: string;
  dbPassword: string;
  supabaseAccessToken: string;
}

interface CreateSupabaseProjectResult {
  projectRef: string;
}

/**
 * Create a new Supabase project under the user's organization.
 *
 * POST https://api.supabase.com/v1/projects
 *   Authorization: Bearer {personal_access_token}
 *   Body: { name, organization_id, plan, region, db_pass }
 *
 * The response includes the new project's `id` (used as `ref` for subsequent
 * API calls and as the subdomain in dashboard/REST URLs). Status starts as
 * "COMING_UP" and must be polled separately — see pollSupabaseProject.
 */
export async function createSupabaseProject(
  params: CreateSupabaseProjectParams
): Promise<CreateSupabaseProjectResult> {
  const {
    name,
    organizationId,
    plan,
    region,
    dbPassword,
    supabaseAccessToken,
  } = params;

  const url = `${SUPABASE_MGMT_API_BASE}/v1/projects`;

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          organization_id: organizationId,
          plan,
          region,
          // db_pass is consumed by Supabase on project create and is never
          // referenced again from this client. Do not capture it in any
          // local variable or log after this point.
          db_pass: dbPassword,
        }),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      "network",
      "Could not reach supabase. Check your internet connection and try again.",
      "supabase"
    );
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw parseProviderError(response.status, errorBody, "supabase");
  }

  const data = (await response.json()) as { id: string };

  if (!data?.id) {
    throw new ProviderError(
      "unknown",
      "Supabase returned a success response without a project ID. The project may not have been created.",
      "supabase"
    );
  }

  return { projectRef: data.id };
}

interface PollSupabaseProjectResult {
  projectRef: string;
  status: string;
  dashboardUrl: string;
}

// Terminal failure statuses returned by GET /v1/projects/{ref}. If we see any
// of these, the provisioning will never succeed and we should stop polling
// immediately rather than waiting for the timeout.
const TERMINAL_FAILURE_STATUSES = new Set([
  "UNKNOWN",
  "INIT_FAILED",
  "REMOVED",
  "RESTORE_FAILED",
  "GOING_DOWN",
]);

/**
 * Poll a Supabase project until it reaches ACTIVE_HEALTHY or a terminal
 * failure state. Supabase provisioning is slow — budget at least 5 minutes.
 *
 * Default timeout: 300_000 ms (5 minutes).
 * Default interval: 10_000 ms (10 seconds).
 */
export async function pollSupabaseProject(
  projectRef: string,
  supabaseAccessToken: string,
  timeoutMs = 300_000,
  intervalMs = 10_000
): Promise<PollSupabaseProjectResult> {
  const deadline = Date.now() + timeoutMs;
  const dashboardUrl = `https://supabase.com/dashboard/project/${projectRef}`;

  while (true) {
    // Check timeout before each poll attempt
    if (Date.now() >= deadline) {
      throw new ProviderError(
        "unknown",
        `Supabase project provisioning timed out after ${Math.round(timeoutMs / 1000)}s. The project may still come up — check the Supabase dashboard at ${dashboardUrl}.`,
        "supabase"
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${SUPABASE_MGMT_API_BASE}/v1/projects/${encodeURIComponent(projectRef)}`,
        {
          headers: {
            Authorization: `Bearer ${supabaseAccessToken}`,
          },
        }
      );
    } catch (err) {
      throw new ProviderError(
        "network",
        "Could not reach supabase. Check your internet connection and try again.",
        "supabase"
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw parseProviderError(response.status, errorBody, "supabase");
    }

    const data = (await response.json()) as { id: string; status: string };
    const status = data.status;

    if (status === "ACTIVE_HEALTHY") {
      return { projectRef, status, dashboardUrl };
    }

    if (TERMINAL_FAILURE_STATUSES.has(status)) {
      throw new ProviderError(
        "unknown",
        `Supabase project provisioning failed (status: ${status}). Check the Supabase dashboard at ${dashboardUrl} for details.`,
        "supabase"
      );
    }

    // Still progressing (e.g. COMING_UP, INACTIVE while booting) — wait
    // before polling again.
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
