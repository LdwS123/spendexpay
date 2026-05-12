#!/usr/bin/env bash
# security-check.sh — pre-launch security verification
#
# Run this from the repo root. Exits non-zero if ANY check fails so it can be
# used as a CI gate or pre-commit hook.
#
# What it checks:
#   1. No hardcoded secrets in tracked files (except *.example and docs/)
#   2. All webhook handler files verify a signature
#   3. .gitignore covers .env, .env.*, .mcp.json, .secrets, .secrets.*
#   4. npm audit --production reports zero high/critical
#
# Usage:  ./scripts/security-check.sh
#         ./scripts/security-check.sh --skip-audit    # skip npm audit
#
set -u   # not -e — we want to keep going and report ALL failures, not bail on first

# ---------- pretty output ----------
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

FAIL_COUNT=0
WARN_COUNT=0

pass()  { printf "%s  PASS%s  %s\n" "$GREEN" "$RESET" "$1"; }
fail()  { printf "%s  FAIL%s  %s\n" "$RED"   "$RESET" "$1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
warn()  { printf "%s  WARN%s  %s\n" "$YELLOW" "$RESET" "$1"; WARN_COUNT=$((WARN_COUNT+1)); }
section() { printf "\n%s== %s ==%s\n" "$BOLD" "$1" "$RESET"; }

# ---------- args ----------
SKIP_AUDIT=0
for arg in "$@"; do
  case "$arg" in
    --skip-audit) SKIP_AUDIT=1 ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //'
      exit 0
      ;;
  esac
done

# ---------- locate repo root ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "Cannot cd to repo root: $REPO_ROOT"; exit 2; }

printf "%sSpendex Pay — security pre-flight%s\n" "$BOLD" "$RESET"
printf "Repo: %s\n" "$REPO_ROOT"

# ---------- 1. hardcoded secret patterns ----------
section "Hardcoded secret patterns"

# Patterns: live & test Stripe keys, Stripe webhook signing secrets,
# Supabase service-role / publishable secrets, generic bearer tokens.
# Restrict scope: tracked files only, excluding *.example and docs/.
SECRET_PATTERN='sk_(live|test)_[A-Za-z0-9]{20,}|rk_(live|test)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  warn "Not a git repository — skipping git-tracked secret scan"
else
  # exclude .example files, docs/, and the secrets-rotation/checklist docs themselves
  HITS=$(git grep -nIE "$SECRET_PATTERN" -- \
            ':!*.example' \
            ':!*.example.*' \
            ':!docs/' \
            ':!scripts/security-check.sh' \
            ':!.secrets*' \
            2>/dev/null || true)
  if [ -z "$HITS" ]; then
    pass "No live secret-shaped strings found in tracked files"
  else
    fail "Secret-shaped strings detected in tracked files:"
    printf "%s\n" "$HITS" | sed 's/^/        /'
  fi
fi

# Also scan untracked-but-not-ignored files (catches a forgotten file before commit)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null || true)
  WT_HITS=""
  if [ -n "$UNTRACKED" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      [ -f "$f" ] || continue
      case "$f" in
        *.example|*.example.*|docs/*|scripts/security-check.sh) continue ;;
      esac
      MATCH=$(grep -IEn "$SECRET_PATTERN" "$f" 2>/dev/null || true)
      if [ -n "$MATCH" ]; then
        WT_HITS+="$f: $MATCH"$'\n'
      fi
    done <<< "$UNTRACKED"
  fi
  if [ -z "$WT_HITS" ]; then
    pass "No secret-shaped strings in untracked (non-gitignored) files"
  else
    fail "Secret-shaped strings in untracked files about to be committed:"
    printf "%s" "$WT_HITS" | sed 's/^/        /'
  fi
fi

# ---------- 2. webhook signature verification ----------
section "Webhook signature verification"

# Find every route file under */api/webhooks/* and verify it references a
# signature header / verification helper. This is a heuristic, not proof, but
# catches the common mistake of forgetting verification entirely.
WEBHOOK_FILES=$(git ls-files 2>/dev/null | grep -E 'api/webhooks/.*/route\.(t|j)sx?$' || true)

if [ -z "$WEBHOOK_FILES" ]; then
  warn "No webhook route files matched glob — verify path scheme"
else
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if grep -qE 'Stripe-Signature|stripe-signature|svix-signature|X-Telegram-Bot-Api-Secret-Token|constructEvent|verifyHeader|timingSafeEqual' "$f"; then
      pass "  $f  (has signature/verify reference)"
    else
      fail "  $f  (no signature verification reference found)"
    fi
  done <<< "$WEBHOOK_FILES"
fi

# ---------- 3. .gitignore coverage ----------
section ".gitignore coverage"

check_ignored() {
  local pattern="$1"
  if git check-ignore -q "$pattern" 2>/dev/null; then
    pass ".gitignore covers $pattern"
  else
    fail ".gitignore does NOT cover $pattern"
  fi
}

# Test against a hypothetical filename matching each pattern.
check_ignored ".env"
check_ignored ".env.production"
check_ignored ".mcp.json"
check_ignored ".secrets.new.txt"
check_ignored ".secrets"

# .env.example MUST NOT be ignored (it's the template that ships with the repo)
if git check-ignore -q .env.example 2>/dev/null; then
  fail ".env.example IS gitignored — should be tracked"
else
  pass ".env.example is tracked (not ignored)"
fi

# ---------- 4. npm audit ----------
section "npm audit --production"

if [ "$SKIP_AUDIT" -eq 1 ]; then
  warn "Skipped (--skip-audit)"
elif ! command -v npm >/dev/null 2>&1; then
  warn "npm not on PATH — skipping audit"
else
  AUDIT_JSON=$(npm audit --production --json 2>/dev/null || true)
  if [ -z "$AUDIT_JSON" ]; then
    warn "npm audit produced no output (offline? no lockfile?)"
  else
    HIGH=$(printf "%s" "$AUDIT_JSON" | grep -oE '"high"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$' || echo 0)
    CRIT=$(printf "%s" "$AUDIT_JSON" | grep -oE '"critical"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$' || echo 0)
    HIGH=${HIGH:-0}
    CRIT=${CRIT:-0}
    if [ "$HIGH" -eq 0 ] && [ "$CRIT" -eq 0 ]; then
      pass "0 high, 0 critical advisories in production deps"
    else
      fail "$HIGH high, $CRIT critical advisories — run 'npm audit --production' for details"
    fi
  fi

  # Repeat for dashboard if it has its own package.json
  if [ -f dashboard/package.json ]; then
    pushd dashboard >/dev/null
    DASH_JSON=$(npm audit --production --json 2>/dev/null || true)
    if [ -n "$DASH_JSON" ]; then
      DHIGH=$(printf "%s" "$DASH_JSON" | grep -oE '"high"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$' || echo 0)
      DCRIT=$(printf "%s" "$DASH_JSON" | grep -oE '"critical"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$' || echo 0)
      DHIGH=${DHIGH:-0}
      DCRIT=${DCRIT:-0}
      if [ "$DHIGH" -eq 0 ] && [ "$DCRIT" -eq 0 ]; then
        pass "dashboard: 0 high, 0 critical"
      else
        fail "dashboard: $DHIGH high, $DCRIT critical — run 'cd dashboard && npm audit --production'"
      fi
    else
      warn "dashboard: npm audit produced no output"
    fi
    popd >/dev/null
  fi
fi

# ---------- 5. .env not in git history ----------
section "git history check"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ENV_IN_HISTORY=$(git log --all --pretty=format: --name-only --diff-filter=A 2>/dev/null \
                   | grep -E '(^|/)\.env(\.|$)|(^|/)\.mcp\.json$|(^|/)\.secrets' \
                   | grep -vE '\.example(\.|$)' \
                   | sort -u || true)
  if [ -z "$ENV_IN_HISTORY" ]; then
    pass "No .env / .mcp.json / .secrets files in git history"
  else
    fail "Sensitive files present in git history:"
    printf "%s\n" "$ENV_IN_HISTORY" | sed 's/^/        /'
    printf "        %sConsider 'git filter-repo' to purge them, then rotate ALL leaked secrets.%s\n" "$YELLOW" "$RESET"
  fi
fi

# ---------- summary ----------
section "Summary"
printf "Failures: %d\n" "$FAIL_COUNT"
printf "Warnings: %d\n" "$WARN_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  printf "\n%sSECURITY CHECK FAILED.%s Fix the items above before launching.\n" "$RED" "$RESET"
  exit 1
fi

if [ "$WARN_COUNT" -gt 0 ]; then
  printf "\n%sPassed with warnings.%s Review warnings before launching.\n" "$YELLOW" "$RESET"
  exit 0
fi

printf "\n%sAll checks passed.%s\n" "$GREEN" "$RESET"
exit 0
