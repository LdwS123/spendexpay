#!/usr/bin/env bash
#
# scripts/publish.sh — bump version, push tag, let GitHub Actions publish to npm.
#
# Usage:
#   ./scripts/publish.sh           # patch bump (0.1.0 → 0.1.1)
#   ./scripts/publish.sh patch     # explicit patch bump
#   ./scripts/publish.sh minor     # 0.1.0 → 0.2.0
#   ./scripts/publish.sh major     # 0.1.0 → 1.0.0
#
# Requires:
#   - clean git tree (no uncommitted changes)
#   - NPM_TOKEN secret configured in GitHub repo settings
#   - publish-npm.yml workflow on the default branch

set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-patch}"

case "$BUMP" in
  patch|minor|major) ;;
  *)
    echo "Error: bump must be one of patch, minor, major (got: $BUMP)" >&2
    exit 1
    ;;
esac

# 1. Clean git tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: git tree is not clean. Commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

# 2. Must be on main
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: must be on main branch (currently: $CURRENT_BRANCH)" >&2
  exit 1
fi

# 3. Pull latest
echo "→ Pulling latest main..."
git pull --ff-only origin main

# 4. Build + test locally before tagging
echo "→ Building..."
npm run build
echo "→ Testing..."
SPENDEX_DEV=true npm test

# 5. Bump version (creates a commit + tag)
echo "→ Bumping $BUMP version..."
NEW_VERSION="$(npm version "$BUMP" -m "chore(release): %s")"
echo "→ New version: $NEW_VERSION"

# 6. Push commit + tag — this triggers publish-npm.yml
echo "→ Pushing commit and tag..."
git push origin main
git push origin "$NEW_VERSION"

echo ""
echo "Published! GitHub Actions is now building + publishing."
echo "Track it: https://github.com/spendexai/mcp/actions"
echo "Once green: https://www.npmjs.com/package/@spendexai/mcp"
