#!/usr/bin/env bash
#
# scripts/deploy-prod.sh — manual production deploy of the MCP server to Fly.io.
#
# Usually CI handles this on push to main (see .github/workflows/deploy-fly.yml),
# but this script is here for emergency manual deploys.
#
# Usage:
#   ./scripts/deploy-prod.sh
#
# Requires:
#   - flyctl installed and authenticated (`fly auth login`)
#   - fly.toml at repo root pointing at the right app

set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Verify flyctl is installed
if ! command -v fly >/dev/null 2>&1; then
  echo "Error: flyctl not found. Install: https://fly.io/docs/hands-on/install-flyctl/" >&2
  exit 1
fi

# 2. Verify auth
if ! fly auth whoami >/dev/null 2>&1; then
  echo "Error: not authenticated with Fly.io. Run: fly auth login" >&2
  exit 1
fi

USER="$(fly auth whoami)"
echo "→ Deploying as: $USER"

# 3. Deploy (remote builder, no local Docker required)
echo "→ Running fly deploy --remote-only..."
fly deploy --remote-only

# 4. Health check
HEALTH_URL="https://spendex-mcp.fly.dev/health"
echo "→ Waiting 5s for warm-up, then hitting $HEALTH_URL..."
sleep 5

if curl --fail --silent --show-error --max-time 10 "$HEALTH_URL" >/dev/null; then
  echo ""
  echo "Deploy succeeded — health check OK."
  echo "URL: https://spendex-mcp.fly.dev"
else
  echo "" >&2
  echo "Warning: deploy completed but health check at $HEALTH_URL failed." >&2
  echo "Check logs: fly logs" >&2
  exit 1
fi
