# Cron setup — weekly digest & scheduled jobs

This doc covers how Spendex Pay's recurring jobs are scheduled. Today there
is one: the weekly digest email (Monday 9 UTC).

## Vercel Cron (production)

The dashboard ships a `vercel.json` at `dashboard/vercel.json`:

```json
{
  "crons": [
    { "path": "/api/digests/weekly", "schedule": "0 9 * * 1" }
  ]
}
```

`0 9 * * 1` = every Monday at 09:00 UTC. Vercel evaluates the schedule in
UTC; users in CET get the digest at 10:00 / 11:00 local depending on DST.

### Auth

Vercel automatically sets an `Authorization: Bearer ${CRON_SECRET}` header
on every cron request. Set `CRON_SECRET` in the Vercel project's environment
variables (a long random string, e.g. `openssl rand -hex 32`). The
`/api/digests/weekly` route verifies this header in constant time before
running.

Alternative auth — the route also accepts `X-Internal-Token` matching
`NOTIFY_INTERNAL_TOKEN`. Use this if you're triggering the job from a
non-Vercel platform (GitHub Actions, a manual `curl`, etc.).

### Free-tier limit

On Vercel's free Hobby tier, **only one cron expression per project** is
allowed and it can fire at most once per day. The Monday-9-UTC schedule
above satisfies both constraints. If we later need additional scheduled
jobs we need to either:
- Upgrade the project to Pro, or
- Consolidate jobs into a single dispatcher route that fans out internally
  based on the current weekday/hour.

## Manual trigger (for testing)

```bash
curl -X POST https://app.spendexai.com/api/digests/weekly \
  -H "X-Internal-Token: $NOTIFY_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<uuid>"}'
```

Omit `user_id` to fan out to every active user (anyone with at least one
audit_logs row in the last 30 days). Include `week_start` to override the
window:

```bash
curl -X POST .../api/digests/weekly \
  -H "X-Internal-Token: $NOTIFY_INTERNAL_TOKEN" \
  -d '{"user_id":"<uuid>","week_start":"2026-05-04"}'
```

## Idempotency

Each `(user_id, week_start)` is recorded in the `digest_runs` table with a
UNIQUE constraint. Re-running the cron job within the same week is safe:
duplicates short-circuit before the email is sent. If you need to force a
resend (e.g. you fixed a template bug), delete the row first:

```sql
delete from digest_runs
where user_id = '<uuid>' and week_start = '2026-05-05';
```

## GitHub Actions fallback

If Vercel Cron is unavailable or we hit the free-tier ceiling, run from
GitHub Actions:

```yaml
# .github/workflows/weekly-digest.yml
name: Weekly digest
on:
  schedule:
    - cron: "0 9 * * 1"
  workflow_dispatch: {}
jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: POST to digest endpoint
        run: |
          curl -fsS -X POST "${{ secrets.APP_URL }}/api/digests/weekly" \
            -H "X-Internal-Token: ${{ secrets.NOTIFY_INTERNAL_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{}'
```

Stick to one trigger source at a time — running both Vercel Cron and the
GitHub Actions workflow will not double-send (idempotency catches it) but
will waste compute.

## Database schema

The route depends on a single table:

```sql
create table if not exists digest_runs (
  user_id      uuid not null,
  week_start   date not null,
  status       text not null default 'pending', -- pending | sent | failed | skipped
  error_message text,
  sent_at      timestamptz,
  primary key (user_id, week_start)
);
```

The composite primary key is what powers idempotency — a duplicate insert
returns `23505` (unique_violation) which the route handler interprets as
"already sent this week".
