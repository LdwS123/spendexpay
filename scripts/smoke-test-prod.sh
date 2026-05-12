#!/usr/bin/env bash
#
# Production smoke test for the Spendex Pay dashboard.
#
# Usage:
#   ./scripts/smoke-test-prod.sh                          # default URL
#   ./scripts/smoke-test-prod.sh https://staging.example  # custom URL
#
# Exits 0 if all checks pass, non-zero on the first failure.
# Each check echoes its outcome to stdout. No external deps beyond curl + grep.

set -u
set -o pipefail

URL="${1:-https://app.spendexai.com}"
URL="${URL%/}"  # trim trailing slash

PASS=0
FAIL=0

# Colors only if stdout is a TTY.
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

ok() {
  echo "${GREEN}PASS${RESET}  $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "${RED}FAIL${RESET}  $1"
  echo "${DIM}      $2${RESET}"
  FAIL=$((FAIL + 1))
  exit 1
}

echo "Smoke testing ${URL}"
echo

# ─── Check 1: /api/health returns 200 + status=ok ───────────────────────────
NAME="GET /api/health returns 200 and status=ok"
RESP="$(curl -sS -o /tmp/spendex-health.json -w '%{http_code}' --max-time 10 "${URL}/api/health" || echo "000")"
if [ "$RESP" != "200" ]; then
  fail "$NAME" "HTTP $RESP (expected 200). Body: $(head -c 200 /tmp/spendex-health.json 2>/dev/null || true)"
fi
if ! grep -q '"status":"ok"' /tmp/spendex-health.json; then
  fail "$NAME" "Response did not include \"status\":\"ok\". Body: $(head -c 200 /tmp/spendex-health.json)"
fi
ok "$NAME"

# ─── Check 2: / returns 200 + contains "Spendex Pay" ────────────────────────
NAME="GET / returns 200 and contains 'Spendex Pay'"
RESP="$(curl -sS -o /tmp/spendex-root.html -w '%{http_code}' --max-time 10 "${URL}/" || echo "000")"
if [ "$RESP" != "200" ]; then
  fail "$NAME" "HTTP $RESP (expected 200)"
fi
if ! grep -q "Spendex Pay" /tmp/spendex-root.html; then
  fail "$NAME" "Body did not contain 'Spendex Pay'"
fi
ok "$NAME"

# ─── Check 3: /docs returns 200 ─────────────────────────────────────────────
NAME="GET /docs returns 200"
RESP="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${URL}/docs" || echo "000")"
if [ "$RESP" != "200" ]; then
  fail "$NAME" "HTTP $RESP (expected 200)"
fi
ok "$NAME"

# ─── Check 4: /dashboard redirects to /login (302) ──────────────────────────
NAME="GET /dashboard redirects to /login (3xx)"
# -o /dev/null discards body; we want headers via -D. Don't follow redirects.
RESP="$(curl -sS -D /tmp/spendex-dash.headers -o /dev/null -w '%{http_code}' --max-time 10 "${URL}/dashboard" || echo "000")"
case "$RESP" in
  301|302|303|307|308)
    LOCATION="$(grep -i '^location:' /tmp/spendex-dash.headers | tr -d '\r' | head -1)"
    if echo "$LOCATION" | grep -qi '/login'; then
      ok "$NAME"
    else
      fail "$NAME" "Got $RESP but Location header was: $LOCATION"
    fi
    ;;
  *)
    fail "$NAME" "HTTP $RESP (expected 3xx redirect to /login)"
    ;;
esac

# ─── Check 5: OPTIONS /api/onboarding — route exists (any non-5xx accepted) ─
NAME="OPTIONS /api/onboarding route exists"
RESP="$(curl -sS -X OPTIONS -o /dev/null -w '%{http_code}' --max-time 10 "${URL}/api/onboarding" || echo "000")"
case "$RESP" in
  200|204|405)
    ok "$NAME"
    ;;
  404)
    fail "$NAME" "HTTP 404 — route is missing"
    ;;
  *)
    if [ -z "$RESP" ] || [ "$RESP" = "000" ] || [ "$RESP" -ge 500 ]; then
      fail "$NAME" "HTTP $RESP (expected 200/204/405)"
    else
      ok "$NAME"
    fi
    ;;
esac

echo
echo "${GREEN}OK All smoke tests pass on ${URL}${RESET}"
echo "Passed: $PASS  Failed: $FAIL"
exit 0
