# GitHub repo setup — CI/CD secrets

Before the workflows in `.github/workflows/` will run successfully, the
following **5 GitHub Secrets** must be configured on the repository.

## How to add a secret

1. Go to the GitHub repo → **Settings**
2. Left sidebar → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name it exactly as listed below (case-sensitive), paste the value, save

## Required secrets

| Secret name | Used by | Where to get it |
|---|---|---|
| `NPM_TOKEN` | `publish-npm.yml` | <https://www.npmjs.com/settings/~/tokens> → **Generate New Token** → choose **Automation** (CI-safe, bypasses 2FA). Copy immediately; you can't view it again. |
| `FLY_API_TOKEN` | `deploy-fly.yml` | <https://fly.io/user/personal_access_tokens> → **Create access token**. Or run `fly auth token` locally and copy the output. |
| `VERCEL_TOKEN` | `deploy-vercel.yml` | <https://vercel.com/account/tokens> → **Create Token** → scope to the right team and a long-enough expiration. |
| `VERCEL_ORG_ID` | `deploy-vercel.yml` | Run `cat dashboard/.vercel/project.json` after `vercel link`, or check **Vercel → Settings → General → Team ID**. Format: `team_…` or `user_…`. |
| `VERCEL_PROJECT_ID` | `deploy-vercel.yml` | Same `dashboard/.vercel/project.json` file under `"projectId"`, or **Vercel → your project → Settings → General → Project ID**. Format: `prj_…`. |

## Bootstrapping the two Vercel IDs

From a machine with the Vercel CLI installed and `vercel login` done:

```bash
cd dashboard
vercel link            # walks you through picking team + project
cat .vercel/project.json
# {
#   "orgId": "team_xxxxxxxxxxxx",      ← VERCEL_ORG_ID
#   "projectId": "prj_xxxxxxxxxxxx"     ← VERCEL_PROJECT_ID
# }
```

`.vercel/` is in `.gitignore` — don't commit it.

## Workflow → secret matrix

| Workflow | Trigger | Needs |
|---|---|---|
| `test.yml` | push to `main`, PRs | (none — public actions only) |
| `publish-npm.yml` | tag `v*` push | `NPM_TOKEN` |
| `deploy-fly.yml` | push to `main` touching server code | `FLY_API_TOKEN` |
| `deploy-vercel.yml` | push to `main` touching `dashboard/**` | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` |

## Verifying the secrets work

After adding all five, push a small change to `main` and watch the
**Actions** tab. The four workflows that should run on a typical push:

- `Test` — always
- `Deploy MCP server to Fly.io` — only if `src/**` etc. changed
- `Deploy dashboard to Vercel` — only if `dashboard/**` changed
- `Publish to npm` — only on `git push origin v0.x.y` tags

To trigger a publish, use the helper script:

```bash
./scripts/publish.sh patch   # or minor / major
```

It bumps the version, pushes the tag, and the workflow takes over.
