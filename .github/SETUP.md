# GitHub repo setup — CI/CD secrets

Spendex Pay ships through GitHub Actions: tests on every PR, npm publish on tag, Fly.io deploy on server changes, Vercel deploy on dashboard changes. None of those workflows will run successfully until you've added the right secrets.

This guide walks you through it end-to-end, from account creation to verification.

---

## Prerequisites

Create or confirm access to these accounts before you start. Each takes a couple of minutes.

| Service | Why | Signup |
|---|---|---|
| GitHub | Hosts the repo and runs the workflows. Need admin rights to add secrets. | <https://github.com/join> |
| npm | Publishes the `@spendexai/mcp` package. | <https://www.npmjs.com/signup> |
| Fly.io | Hosts the Streamable HTTP MCP server. | <https://fly.io/app/sign-up> |
| Vercel | Hosts the dashboard (Next.js 15). | <https://vercel.com/signup> |

Once accounts exist, you'll generate one token per service and store it as a GitHub Actions secret on the repo.

---

## How to add a GitHub secret

You'll repeat this five times — once per secret listed below.

1. Open the GitHub repo in your browser.
2. Click **Settings** (top nav of the repo).
3. In the left sidebar: **Secrets and variables → Actions**.
4. Click **New repository secret**.
5. **Name** — exactly as listed below (case-sensitive).
6. **Secret** — paste the token value.
7. Click **Add secret**.

Or, if you prefer the CLI, every section below also shows the matching `gh secret set` command.

---

## Required secrets

### 1. `NPM_TOKEN` — for `publish-npm.yml`

**Where to get it:** <https://www.npmjs.com/settings/~/tokens>

1. Sign in to npm.
2. Click your avatar (top right) → **Access Tokens**.
3. Click **Generate New Token → Classic Token**.
4. Choose **Automation** (this type bypasses 2FA — required for CI).
5. Name it `spendex-ci`, leave the expiration default.
6. Click **Generate Token**. Copy immediately — npm won't show it again.

```
┌────────────────────────────────────────────────────────┐
│  npm Access Tokens                                     │
│  ┌──────────────────────────────────────────────────┐  │
│  │  [ Generate New Token ▾ ]    ← click here        │  │
│  │     • Classic Token                              │  │
│  │     • Granular Access Token                      │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  Type: ( ) Read-only  ( ) Publish  (•) Automation      │
│                                  └─ pick this one      │
└────────────────────────────────────────────────────────┘
```

**Add to GitHub:**

```bash
gh secret set NPM_TOKEN --body "npm_REPLACE_ME"
```

---

### 2. `FLY_API_TOKEN` — for `deploy-fly.yml`

**Where to get it:** <https://fly.io/user/personal_access_tokens>

1. Sign in to Fly.
2. Open the URL above.
3. Click **Create access token**.
4. Name it `spendex-ci`, leave the expiration at the default (or set it as long as you're comfortable rotating).
5. Click **Create**. Copy the token immediately.

Or, if you've already run `fly auth login` locally:

```bash
fly auth token
# prints the token to stdout
```

```
┌────────────────────────────────────────────────────────┐
│  Fly.io → Account → Access Tokens                      │
│  ┌──────────────────────────────────────────────────┐  │
│  │  [ Create access token ]  ← click here           │  │
│  │                                                  │  │
│  │  Name: spendex-ci                                │  │
│  │  Expires in: 1 year                              │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

**Add to GitHub:**

```bash
gh secret set FLY_API_TOKEN --body "FlyV1_REPLACE_ME"
```

---

### 3. `VERCEL_TOKEN` — for `deploy-vercel.yml`

**Where to get it:** <https://vercel.com/account/tokens>

1. Sign in to Vercel.
2. Open the URL above.
3. Click **Create Token**.
4. Name it `spendex-ci`.
5. Scope: select the team that owns the Spendex project (or your personal account if it's not in a team).
6. Expiration: 1 year is a sensible default.
7. Click **Create**. Copy the token immediately.

```
┌────────────────────────────────────────────────────────┐
│  Vercel → Account Settings → Tokens                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │  [ Create Token ]  ← click here                  │  │
│  │                                                  │  │
│  │  Name:  spendex-ci                               │  │
│  │  Scope: Full Account / Team: spendex-ai          │  │
│  │  Expiration: 1 year                              │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

**Add to GitHub:**

```bash
gh secret set VERCEL_TOKEN --body "REPLACE_ME"
```

---

### 4. `VERCEL_ORG_ID` and 5. `VERCEL_PROJECT_ID` — for `deploy-vercel.yml`

These two IDs identify which team and which project the dashboard deploys to. Easiest way to get both is to link the project locally:

```bash
cd dashboard
vercel link            # walks you through picking team + project
cat .vercel/project.json
```

You'll see:

```json
{
  "orgId":     "team_xxxxxxxxxxxx",
  "projectId": "prj_xxxxxxxxxxxx"
}
```

```
┌────────────────────────────────────────────────────────┐
│  dashboard/.vercel/project.json                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │  {                                               │  │
│  │    "orgId":     "team_xxxxxxxxxxxx",  ← ORG_ID   │  │
│  │    "projectId": "prj_xxxxxxxxxxxx"    ← PROJ_ID  │  │
│  │  }                                               │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

If you'd rather copy them from the dashboard UI:

- **Org ID** — Vercel → **Settings → General → Team ID**. Format: `team_…` (or `user_…` for personal accounts).
- **Project ID** — Vercel → the project → **Settings → General → Project ID**. Format: `prj_…`.

`.vercel/` is in `.gitignore` — don't commit it.

**Add both to GitHub:**

```bash
gh secret set VERCEL_ORG_ID --body "team_REPLACE_ME"
gh secret set VERCEL_PROJECT_ID --body "prj_REPLACE_ME"
```

---

## Workflow → secret matrix

| Workflow | Trigger | Needs |
|---|---|---|
| `test.yml` | push to `main`, PRs | (none — public actions only) |
| `publish-npm.yml` | tag `v*` push | `NPM_TOKEN` |
| `deploy-fly.yml` | push to `main` touching server code | `FLY_API_TOKEN` |
| `deploy-vercel.yml` | push to `main` touching `dashboard/**` | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` |

---

## Verify setup

After adding all five, run these from the repo root to confirm the secrets and workflows are in place.

### Check secrets

```bash
gh secret list
```

Expected output (the timestamps will differ):

```
FLY_API_TOKEN          Updated 2026-05-12
NPM_TOKEN              Updated 2026-05-12
VERCEL_ORG_ID          Updated 2026-05-12
VERCEL_PROJECT_ID      Updated 2026-05-12
VERCEL_TOKEN           Updated 2026-05-12
```

If any of the five is missing, GitHub Actions will fail silently with a confusing "secret not found" message at runtime, not at config time. Better to catch it here.

### Check workflows

```bash
gh workflow list
```

Expected output:

```
NAME                                STATE   ID
Test                                active  ...
Publish to npm                      active  ...
Deploy MCP server to Fly.io         active  ...
Deploy dashboard to Vercel          active  ...
```

If a workflow is listed as `disabled`, re-enable it from the **Actions** tab in the GitHub UI.

### End-to-end smoke test

Push a small documentation-only change to `main` and watch the **Actions** tab. You should see:

- `Test` — always runs, should pass.
- `Deploy MCP server to Fly.io` — skipped (no server code touched).
- `Deploy dashboard to Vercel` — skipped (no dashboard code touched).
- `Publish to npm` — skipped (only triggers on `v*` tags).

To trigger a real publish, use the helper script:

```bash
./scripts/publish.sh patch   # or minor / major
```

It bumps the version, pushes the tag, and the `publish-npm.yml` workflow takes over.

---

## Rotating secrets

When a token leaks, gets rotated, or a team member offboards:

1. Generate a fresh token at the same URL listed above.
2. Run `gh secret set <NAME> --body "..."` to overwrite the old value (no need to delete first).
3. Revoke the old token at the issuer (npm, Fly, Vercel) so a stolen copy stops working.
4. Trigger a re-run of any in-flight workflow that used the old secret.
