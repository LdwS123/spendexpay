# supabase/migrations

**Mirror of `/migrations/` — do not edit directly.**

The canonical migrations live at the repository root in [`/migrations/`](../../migrations/).
This directory exists only so the Supabase CLI (`supabase db push`,
`supabase migration up`) can find the files at the path it expects.

## How to update

When adding a new migration:

1. Write the SQL file in `/migrations/NNN_name.sql` (root canon).
2. Copy it verbatim into this directory: `cp migrations/NNN_name.sql supabase/migrations/`.
3. Apply it to live via the Supabase MCP `apply_migration` tool or the
   Supabase dashboard SQL editor.

## Files

| File | Source |
|---|---|
| `001_initial_schema.sql` → `007_audit_logs_status_expand.sql` | Mirror of `/migrations/`. Apply in numeric order on a fresh project. |
| `999_extra_rls.sql` | Defensive `RESTRICTIVE` deny-all RLS policies for `anon` / `authenticated` roles. **Not present in `/migrations/`** because the canon schema already enables RLS without explicit policies (default deny). Apply this file only if you want belt-and-braces explicit deny policies visible in `pg_policies`. |

## Why two directories?

- `/migrations/` is the source of truth used by the runbook in `DEPLOY.md`
  and by the Supabase MCP tooling.
- `/supabase/migrations/` is what the local Supabase CLI scans. Keeping
  them in sync (copy, not symlink, so the files survive `git archive`)
  avoids a "which one is canonical?" question every time a new engineer
  joins.
