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
#   frontend/**           → [npm ci if lockfile changed] → vite build into
#                          dist.next → atomic swap into dist/ (nginx serves
#                          dist/ from disk — no restart needed; a failed build
#                          never touches the live dist)
#   only README/deploy/…  → nothing ("nothing to deploy")
#
# Frontend freshness: deploy/.last-frontend-sha (untracked, VM-local) records
# the commit the live dist was built from — when that cannot be proven to line
# up with the diff's baseline, the frontend is force-rebuilt rather than
# risking stale assets (see the decision block below).
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

# Frontend freshness tracking: deploy/.last-frontend-sha (untracked, VM-local)
# records the commit the LIVE frontend/dist was last successfully built from —
# written only after a build finished AND the atomic dist.next swap (below)
# completed. The diff range alone is only sound when dist actually corresponds
# to the range's base: staleness accumulated OUTSIDE any deploy window (manual
# `git pull`/`git reset --hard` on the VM, a first-ever CI run passing the
# all-zero `before` SHA, a previously failed deploy, …) is invisible to a pure
# diff. So the decision is:
#   dist already built from the TARGET commit     → skip frontend (true rerun)
#   dist built from the range's base (provably)   → trust the diff
#   freshness UNPROVABLE (no/mismatched state
#   file, or dist missing)                        → force a frontend rebuild
FRONTEND_STATE="$REPO_ROOT/deploy/.last-frontend-sha"
last_fe_sha="$(head -n 1 "$FRONTEND_STATE" 2>/dev/null | tr -d '[:space:]' || true)"
# Garbage/foreign state is as good as no state.
if [ -n "$last_fe_sha" ] && ! git -C "$REPO_ROOT" cat-file -e "${last_fe_sha}^{commit}" 2>/dev/null; then
  last_fe_sha=""
fi

# Target commit of this deploy (the NEW end of every range below). $3 (CI's
# new-sha) is intentionally NOT used for diffing: gha-deploy-remote.sh has
# already verified HEAD == origin/main before calling this script, and hook
# runs have no $3 — HEAD is the deploy target in both paths.
new_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"

if [ "$MODE" = "--full" ]; then
  echo "mode: FULL (forced rebuild of backend + frontend)"
  dep_backend=1; ci_backend=1; dep_frontend=1; ci_frontend=1
else
  # Range base: explicit old..new args win (CI passes github.event.before — the
  # all-zero SHA on a first run fails the commit check and is ignored); else
  # the ORIG_HEAD..HEAD diff the merge/rebase behind `git pull` just left.
  old_sha=""
  if [ -n "${2:-}" ] && git -C "$REPO_ROOT" cat-file -e "${2}^{commit}" 2>/dev/null; then
    old_sha="${2}"
  elif git -C "$REPO_ROOT" rev-parse -q --verify ORIG_HEAD >/dev/null 2>&1; then
    old_sha="$(git -C "$REPO_ROOT" rev-parse ORIG_HEAD 2>/dev/null || true)"
  fi

  # Sound baseline for the diff: the pull's base; when that is unknown to this
  # clone, fall back to the commit dist was last built from — still the most
  # authoritative answer to "what changed since the live frontend".
  baseline="$old_sha"
  if [ -z "$baseline" ]; then
    baseline="$last_fe_sha"
  fi

  if [ -z "$baseline" ] || [ -z "$new_sha" ]; then
    echo "mode: no diff range known → falling back to FULL"
    dep_backend=1; ci_backend=1; dep_frontend=1; ci_frontend=1
  elif [ "$baseline" = "$new_sha" ]; then
    # Empty range: nothing to diff. The frontend is a no-op only when PROVABLY
    # fresh (state file names this exact commit AND dist exists); otherwise an
    # empty range proves nothing → force a frontend rebuild. The backend has no
    # freshness marker and the diff is empty, so it is left untouched (rerun-
    # safe — gha-deploy-remote.sh already gates true no-op reruns upstream).
    if [ -d "$FRONTEND_DIR/dist" ] && [ -n "$last_fe_sha" ] && [ "$last_fe_sha" = "$new_sha" ]; then
      echo "✅ frontend/dist already built from ${new_sha:0:12} — skipping rebuild"
    else
      echo "⚠️  frontend freshness unprovable (last-sha: ${last_fe_sha:-none}, dist: $([ -d "$FRONTEND_DIR/dist" ] && echo present || echo missing)) → forcing frontend rebuild"
      dep_frontend=1
    fi
  else
    echo "mode: diff-driven (${baseline:0:12}..${new_sha:0:12})"
    files="$(git -C "$REPO_ROOT" diff --name-only "$baseline..$new_sha" || true)"
    if grep -q '^backend/'  <<<"$files" 2>/dev/null; then dep_backend=1;  fi
    if grep -q '^frontend/' <<<"$files" 2>/dev/null; then dep_frontend=1; fi
    if grep -qE '^backend/(package\.json|package-lock\.json)$'  <<<"$files" 2>/dev/null; then ci_backend=1;  fi
    if grep -qE '^frontend/(package\.json|package-lock\.json)$' <<<"$files" 2>/dev/null; then ci_frontend=1; fi

    # Freshness gate — overrides the diff for the FRONTEND only:
    if [ "$dep_frontend" = 1 ] && [ -n "$last_fe_sha" ] && [ "$last_fe_sha" = "$new_sha" ] && [ -d "$FRONTEND_DIR/dist" ]; then
      # Range says frontend changed since the baseline, but dist is already
      # built from the TARGET (out-of-band rebuild / rerun after a failed
      # backend deploy) → nothing to do.
      echo "✅ frontend/dist already built from ${new_sha:0:12} — skipping rebuild"
      dep_frontend=0
    elif [ "$dep_frontend" = 0 ]; then
      # Diff says frontend unchanged SINCE THE BASELINE — which only proves
      # dist is current when dist provably corresponds to the baseline (or is
      # already at the target). Anything else → rebuild rather than serve stale.
      if [ ! -d "$FRONTEND_DIR/dist" ] || [ -z "$last_fe_sha" ] || { [ "$last_fe_sha" != "$baseline" ] && [ "$last_fe_sha" != "$new_sha" ]; }; then
        echo "⚠️  frontend freshness unprovable (last-sha: ${last_fe_sha:-none}, base: ${baseline:0:12}, dist: $([ -d "$FRONTEND_DIR/dist" ] && echo present || echo missing)) → forcing frontend rebuild"
        dep_frontend=1
      fi
    fi
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
  # Build into dist.next — the live dist/ is swapped only AFTER a fully
  # successful build, so a failed build never leaves nginx serving a broken or
  # half-written frontend (and never destroys the previous good release).
  echo "+ frontend: npm run build → dist.next"
  rm -rf "$FRONTEND_DIR/dist.next"
  (cd "$FRONTEND_DIR" && npm run build -- --outDir dist.next --emptyOutDir) || {
    rm -rf "$FRONTEND_DIR/dist.next"
    fail "frontend build (vite)"
  }
  # Atomic swap: plain rename(2)s. dist/ only ever exists as a complete build;
  # on any failure the previous dist is restored before aborting.
  rm -rf "$FRONTEND_DIR/dist.prev"
  had_dist=0
  if [ -d "$FRONTEND_DIR/dist" ]; then
    mv "$FRONTEND_DIR/dist" "$FRONTEND_DIR/dist.prev" || fail "frontend swap: could not stage dist.prev"
    had_dist=1
  fi
  if mv "$FRONTEND_DIR/dist.next" "$FRONTEND_DIR/dist"; then
    rm -rf "$FRONTEND_DIR/dist.prev"
    # Record freshness ONLY after the swap — the state file must never claim a
    # commit that is not actually live.
    if [ -n "$new_sha" ]; then
      printf '%s\n' "$new_sha" > "$FRONTEND_STATE"
    fi
    echo "✅ frontend rebuilt from ${new_sha:0:12} — dist swapped in atomically, freshness recorded"
  else
    if [ "$had_dist" = 1 ]; then mv "$FRONTEND_DIR/dist.prev" "$FRONTEND_DIR/dist"; fi
    rm -rf "$FRONTEND_DIR/dist.next"
    fail "frontend swap: dist.next → dist"
  fi
fi

echo "════ deploy complete $(date -Is) ════"