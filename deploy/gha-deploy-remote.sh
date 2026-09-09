#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# AURA-Chart v2 — remote deploy driver for the GitHub Actions workflow
#
# Piped over SSH by .github/workflows/deploy.yml (`ssh ... "bash -s" -- ARGS <
# this file`) and executed ON the Oracle VM as the deploy user (ubuntu).
#
#   Usage: gha-deploy-remote.sh <repo-path> <auto|--full> [old-sha] [new-sha]
#
# Responsibilities:
#   1. verify <repo-path> is the AURA checkout sitting on branch `main`
#   2. git fetch origin main
#   3. git reset --hard origin/main   ← NOT `git pull`: reset fires no
#      post-merge/post-rewrite hooks, so exactly ONE deploy per push even when
#      core.hooksPath=deploy/githooks is configured. Reset only touches TRACKED
#      files — .env / backend/.env / backend/data/ / *.log on the VM are never
#      overwritten from GitHub (they are untracked/gitignored).
#   4. delegate to the repo's own pipeline: deploy/redeploy.sh <mode> <old>
#      <new> — diff-driven npm ci / builds / systemd restart / health gate.
#      Rerun-safe: redeploy.sh's frontend freshness state (deploy/.last-
#      frontend-sha) skips an already-built frontend; a no-op diff exits
#      "nothing to deploy".
#   5. final gate: service active, loopback /api/health returns ok:true, and
#      HEAD == origin/main.
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_PATH="${1:-}"
MODE="${2:-auto}"
OLD_SHA="${3:-}"
NEW_SHA="${4:-}"
SERVICE="aura-backend.service"

fail() { echo "❌ DEPLOY FAILED — $*"; exit 1; }

[ -n "$REPO_PATH" ] || fail "usage: gha-deploy-remote.sh <repo-path> <auto|--full> [old-sha] [new-sha]"
[ -d "$REPO_PATH" ] || fail "repo path does not exist: $REPO_PATH"
cd "$REPO_PATH"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$REPO_PATH is not a git work tree"
branch="$(git symbolic-ref -q --short HEAD || true)"
[ "$branch" = "main" ] || fail "checkout is on branch '${branch:-<detached>}' — expected 'main' (refusing to reset a non-main branch)"

echo "── fetching origin/main ──"
git fetch --prune origin main || fail "git fetch origin main"
remote_head="$(git rev-parse origin/main)" || fail "origin/main not found"

echo "── resetting to origin/main ($remote_head) ──"
# Touches tracked files only; untracked VM state (.env, backend/.env, data/,
# logs) is preserved. Fires no deploy hooks → no double deploy.
git reset --hard origin/main || fail "git reset --hard origin/main"
[ "$(git rev-parse HEAD)" = "$remote_head" ] || fail "HEAD did not land on origin/main"

# ALWAYS delegate — deploy/redeploy.sh is the single source of deployment
# truth and is rerun-safe by construction: deploy/.last-frontend-sha skips an
# already-built frontend, and a no-op diff exits "nothing to deploy". Do NOT
# gate on HEAD == NEW_SHA here: after `git reset --hard origin/main` that
# equality is true for EVERY push-triggered run (it proves source sync, NOT
# deployment completion) — gating on it made CI report success while nothing
# was built or restarted.
echo "── deploy pipeline (deploy/redeploy.sh $MODE) ──"
bash deploy/redeploy.sh "$MODE" "$OLD_SHA" "$NEW_SHA" || fail "deploy/redeploy.sh $MODE"

# ── final deployment health gate ─────────────────────────────────────────────
systemctl is-active --quiet "$SERVICE" || fail "$SERVICE is not active after deploy (journalctl -u $SERVICE -n 50)"
echo "✅ systemctl: $SERVICE is active"

port="$(grep -E '^PORT=' backend/.env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
port="${port:-8787}"
body="$(curl -sf -m 5 "http://127.0.0.1:${port}/api/health")" || fail "loopback /api/health did not answer on :$port"
echo "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true' || fail "loopback /api/health did not report ok:true (body: $body)"
echo "✅ health: http://127.0.0.1:$port/api/health → ok:true"

if curl -sf -m 5 "http://127.0.0.1:80/api/health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo "✅ nginx proxy check (:80 → backend) → ok:true"
else
  echo "::warning::nginx :80 proxy check did not answer ok:true — static/API serving should be verified (deploy itself is healthy)"
fi

echo "════ deploy complete — HEAD $(git rev-parse --short HEAD) ════"