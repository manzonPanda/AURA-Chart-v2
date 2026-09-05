#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AURA-Chart — automatic VM deploy: rebuild backend/frontend + restart service
#
# Wired to run automatically after every pull that brings changes:
#     git config core.hooksPath deploy/githooks      (one-time per clone)
#       deploy/githooks/post-merge   ← fires on `git pull` (merge / ff)
#       deploy/githooks/post-rewrite ← fires on `git pull --rebase`
#
# What runs depends on WHICH files the pull touched:
#   backend/**            → [npm ci if lockfile changed] → tsc build
#                          → sudo systemctl restart aura-backend → health check
#   frontend/**           → [npm ci if lockfile changed] → vite build
#                          (nginx serves dist/ from disk — no restart needed)
#   only README/deploy/…  → nothing ("nothing to deploy")
#
# Manual full deploy (both sides, regardless of git diff):
#     npm run deploy                       # from the repo root
#     bash deploy/redeploy.sh --full
#
# All output is appended to .last-deploy.log (repo root, gitignored).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$REPO_ROOT/.last-deploy.log"
SERVICE="aura-backend.service"
BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"

exec > >(tee -a "$LOG") 2>&1

fail() { echo "❌ DEPLOY FAILED — $*"; echo "── deploy aborted $(date -Is) ──"; exit 1; }

echo ""
echo "════ AURA auto-deploy $(date -Is) ════"

MODE="${1:-auto}"

# ── decide what to rebuild from the pull's diff ──────────────────────────────
dep_backend=0; ci_backend=0; dep_frontend=0; ci_frontend=0

if [ "$MODE" = "--full" ]; then
  echo "mode: FULL (forced rebuild of backend + frontend)"
  dep_backend=1; ci_backend=1; dep_frontend=1; ci_frontend=1
else
  range=""
  # explicit old..new args win (handy for testing); else the ORIG_HEAD..HEAD
  # diff that the merge/rebase behind `git pull` just left behind.
  if [ -n "${2:-}" ] && [ -n "${3:-}" ] && git -C "$REPO_ROOT" cat-file -e "${2}^{commit}" 2>/dev/null; then
    range="${2}..${3}"
  elif git -C "$REPO_ROOT" rev-parse -q --verify ORIG_HEAD >/dev/null 2>&1; then
    range="ORIG_HEAD..HEAD"
  fi

  if [ -n "$range" ]; then
    echo "mode: diff-driven ($range)"
    files="$(git -C "$REPO_ROOT" diff --name-only "$range" || true)"
    if grep -q '^backend/'  <<<"$files" 2>/dev/null; then dep_backend=1;  fi
    if grep -q '^frontend/' <<<"$files" 2>/dev/null; then dep_frontend=1; fi
    if grep -qE '^backend/(package\.json|package-lock\.json)$'  <<<"$files" 2>/dev/null; then ci_backend=1;  fi
    if grep -qE '^frontend/(package\.json|package-lock\.json)$' <<<"$files" 2>/dev/null; then ci_frontend=1; fi
  else
    echo "mode: no diff range known → falling back to FULL"
    dep_backend=1; ci_backend=1; dep_frontend=1; ci_frontend=1
  fi
fi

# a missing node_modules always forces an install
[ -d "$BACKEND_DIR/node_modules" ]  || ci_backend=1
[ -d "$FRONTEND_DIR/node_modules" ] || ci_frontend=1

if [ "$dep_backend" = 0 ] && [ "$dep_frontend" = 0 ]; then
  echo "✅ nothing to deploy (pull touched no backend/frontend files)"
  echo "════ done $(date -Is) ════"
  exit 0
fi

# ── backend ──────────────────────────────────────────────────────────────────
if [ "$dep_backend" = 1 ]; then
  echo "── backend ──"
  if [ "$ci_backend" = 1 ]; then
    echo "+ backend: npm ci"
    (cd "$BACKEND_DIR" && npm ci) || fail "backend npm ci"
  fi
  echo "+ backend: npm run build"
  (cd "$BACKEND_DIR" && npm run build) || fail "backend build (tsc)"

  echo "+ restart $SERVICE"
  sudo -n systemctl restart "$SERVICE" || fail "systemctl restart — needs sudo NOPASSWD for 'systemctl restart $SERVICE'"
  port="$(grep -E '^PORT=' "$BACKEND_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
  port="${port:-8787}"
  ok=""
  for _ in $(seq 1 20); do
    sleep 1
    curl -sf -m 3 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 && { ok=1; break; }
  done
  [ -n "$ok" ] || fail "backend did not answer /api/health on :$port within 20s (see: journalctl -u $SERVICE -n 50)"
  echo "✅ backend rebuilt, restarted and healthy (http://127.0.0.1:$port/api/health)"
fi

# ── frontend ─────────────────────────────────────────────────────────────────
if [ "$dep_frontend" = 1 ]; then
  echo "── frontend ──"
  if [ "$ci_frontend" = 1 ]; then
    echo "+ frontend: npm ci"
    (cd "$FRONTEND_DIR" && npm ci) || fail "frontend npm ci"
  fi
  echo "+ frontend: npm run build"
  (cd "$FRONTEND_DIR" && npm run build) || fail "frontend build (vite)"
  echo "✅ frontend rebuilt — nginx serves dist/ from disk, already live"
fi

echo "════ deploy complete $(date -Is) ════"