#!/usr/bin/env bash
#
# Smoke test for the Spendex MCP server (HTTP transport).
#
# Usage:
#   ./scripts/smoke-test-mcp.sh                            # default URL
#   ./scripts/smoke-test-mcp.sh https://my-mcp.fly.dev     # custom URL
#
# Exits 0 if all checks pass, non-zero on the first failure.
# No external deps beyond curl + grep.

set -u
set -o pipefail

URL="${1:-https://spendex-mcp.fly.dev}"
URL="${URL%/}"

if [ -t 1 ]; then
  GREEN=$'\033[0;32m'
  RED=$'\033[0;31m'
  DIM=$'\033[2m'
  RESET=$'\033[0m'
else
  GREEN=""
  RED=""
  DIM=""
  RESET=""
fi

PASS=0

ok() {
  echo "${GREEN}PASS${RESET}  $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "${RED}FAIL${RESET}  $1"
  echo "${DIM}      $2${RESET}"
  exit 1
}

echo "Smoke testing MCP server at ${URL}"
echo

# ─── Check 1: /health returns 200 ───────────────────────────────────────────
NAME="GET /health returns 200"
RESP="$(curl -sS -o /tmp/mcp-health.txt -w '%{http_code}' --max-time 10 "${URL}/health" || echo "000")"
if [ "$RESP" != "200" ]; then
  fail "$NAME" "HTTP $RESP (expected 200). Body: $(head -c 200 /tmp/mcp-health.txt 2>/dev/null || true)"
fi
ok "$NAME"

# ─── Check 2: POST /mcp initialize returns protocolVersion ──────────────────
NAME="POST /mcp initialize returns protocolVersion"
INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.1"}}}'
HTTP="$(curl -sS -o /tmp/mcp-init.json -w '%{http_code}' --max-time 15 \
  -X POST "${URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$INIT_BODY" || echo "000")"
if [ "$HTTP" != "200" ]; then
  fail "$NAME" "HTTP $HTTP. Body: $(head -c 300 /tmp/mcp-init.json 2>/dev/null || true)"
fi
if ! grep -q 'protocolVersion' /tmp/mcp-init.json; then
  fail "$NAME" "Response did not include 'protocolVersion'. Body: $(head -c 300 /tmp/mcp-init.json)"
fi
ok "$NAME"

# ─── Check 3: POST /mcp tools/list returns >=20 tools ───────────────────────
NAME="POST /mcp tools/list returns >=20 tools"
LIST_BODY='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
HTTP="$(curl -sS -o /tmp/mcp-tools.json -w '%{http_code}' --max-time 15 \
  -X POST "${URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$LIST_BODY" || echo "000")"
if [ "$HTTP" != "200" ]; then
  fail "$NAME" "HTTP $HTTP. Body: $(head -c 300 /tmp/mcp-tools.json 2>/dev/null || true)"
fi
# Count tool entries by counting "name": occurrences inside the tools array.
# This is a heuristic but works across both JSON and SSE-wrapped responses.
COUNT="$(grep -o '"name"[[:space:]]*:' /tmp/mcp-tools.json | wc -l | tr -d ' ')"
if [ -z "$COUNT" ] || [ "$COUNT" -lt 20 ]; then
  fail "$NAME" "Found $COUNT tools (expected >=20). Body: $(head -c 300 /tmp/mcp-tools.json)"
fi
ok "$NAME  (found $COUNT tools)"

echo
echo "${GREEN}OK All MCP smoke tests pass on ${URL}${RESET}"
echo "Passed: $PASS"
exit 0
