#!/usr/bin/env bash
# Regression tests for the CI SSH deploy driver (deploy/gha-deploy-remote.sh)
# after removing the broken "HEAD == NEW_SHA → rerun-safe" skip gate.
#
# Proves, against a throwaway fixture (bare origin + clone; npm, sudo,
# systemctl and curl stubbed — no real builds, no VM, no GitHub):
#   T1  a normal push-triggered run REACHES deploy/redeploy.sh even though
#       `git reset --hard origin/main` makes HEAD == NEW_SHA (the old gate
#       skipped every push and printed "already at origin/main — rerun-safe");
#   T2  a genuine rerun of the same push stays safe (frontend freshness skip,
#       no rebuild, exit 0);
#   T3  backend pushes deploy; rerunning them is idempotent and healthy;
#   T4  re-running an OLD workflow run while origin/main has moved still
#       deploys the CURRENT main;
#   T5  --full through the driver still forces rebuild + npm ci;
#   T6  structural: the skip banner is gone from the driver; bash -n clean;
#   T7  freshness that CANNOT be proven always force-rebuilds the frontend —
#       empty diff range, README-only push, a garbage/unverifyable state file,
#       and stale state pointing to neither the baseline nor the target — the
#       live dist/ is never trusted without proof (staleness accumulated
#       outside a deploy window must never be served).
#
# deploy/redeploy.sh remains the single source of deployment decisions — it is
# only exercised here, never modified. Run from anywhere:  bash deploy/test-deploy.sh
set -u

REAL_ROOT="/c/Users/jakejamesmanzon/Desktop/AURA-Chart v2"
WORK="$(mktemp -d)/aura-driver-test"
mkdir -p "$WORK/stubs" "$WORK/origin.git"
REPO="$WORK/vmrepo"; STUBS="$WORK/stubs"; OUT="$WORK/out.log"
pass=0; fail=0
t()  { local n="$1"; shift; if "$@" >/dev/null 2>&1; then echo "  ✓ $n"; pass=$((pass+1)); else echo "  ✗ $n"; fail=$((fail+1)); fi; }
tn() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then echo "  ✗ $n"; fail=$((fail+1)); else echo "  ✓ $n"; pass=$((pass+1)); fi; }

# ── stubs ─────────────────────────────────────────────────────────────────────
cat > "$STUBS/npm" <<'EOF'
#!/usr/bin/env bash
cmd="$1"; shift || true
case "$cmd" in
  ci) mkdir -p node_modules; exit 0 ;;
  run)
    script="${1:-}"; [ "$script" = "build" ] || { echo "fake npm: unsupported" >&2; exit 1; }
    shift
    if [ "${FAKE_BUILD_FAIL:-0}" = "1" ]; then echo "fake build: failure" >&2; exit 1; fi
    if [ -d src ]; then
      out="dist"
      while [ $# -gt 0 ]; do case "$1" in --outDir) out="$2"; shift 2;; *) shift;; esac; done
      mkdir -p "$out"; printf 'fe-build-%s\n' "$(git rev-parse HEAD 2>/dev/null || echo ?)" > "$out/index.html"
    else
      mkdir -p dist; printf 'be-build\n' > dist/index.js
    fi
    exit 0 ;;
  *) echo "fake npm: unsupported" >&2; exit 1 ;;
esac
EOF
printf '#!/usr/bin/env bash\n[ "${1:-}" = "-n" ] && shift\nexec "$@"\n' > "$STUBS/sudo"
printf '#!/usr/bin/env bash\nexit 0\n'      > "$STUBS/systemctl"
# driver health gate greps the BODY for "ok":true — the stub must emit it
cat > "$STUBS/curl" <<'EOF'
#!/usr/bin/env bash
printf '{"ok":true}\n'
exit 0
EOF
chmod +x "$STUBS/"*

run_driver()  { ( PATH="$STUBS:$PATH" bash "$REPO/deploy/gha-deploy-remote.sh" "$REPO" "$@" ) > "$OUT" 2>&1; echo $?; }
state()       { cat "$REPO/deploy/.last-frontend-sha" 2>/dev/null; }
pushcommit()  { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; git -C "$REPO" add -A >/dev/null 2>&1; git -C "$REPO" commit -qm "$3" >/dev/null 2>&1; git -C "$REPO" push -q origin main 2>/dev/null; git -C "$REPO" rev-parse HEAD; }

# ── fixture: bare origin + clone that plays the VM checkout ───────────────────
git init --bare -b main "$WORK/origin.git" 2>/dev/null || { git init --bare "$WORK/origin.git"; git -C "$WORK/origin.git" symbolic-ref HEAD refs/heads/main; }
git clone -q "$WORK/origin.git" "$REPO" 2>/dev/null
git -C "$REPO" config user.email test@local; git -C "$REPO" config user.name test
mkdir -p "$REPO/backend" "$REPO/frontend/src" "$REPO/deploy"
cp "$REAL_ROOT/deploy/redeploy.sh" "$REPO/deploy/"
cp "$REAL_ROOT/deploy/gha-deploy-remote.sh" "$REPO/deploy/"
# mirror production VM reality: .gitignore keeps runtime artifacts untracked,
# and backend/.env exists (gitignored) so the driver's PORT lookup succeeds
cp "$REAL_ROOT/.gitignore" "$REPO/.gitignore"
printf 'PORT=8787\n' > "$REPO/backend/.env"
printf 'be0\n' > "$REPO/backend/index.ts"
printf 'fe0\n' > "$REPO/frontend/src/app.ts"
printf 'lock0\n' > "$REPO/frontend/package-lock.json"
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -qm "c0 base" >/dev/null 2>&1
git -C "$REPO" push -q origin main 2>/dev/null
C0=$(git -C "$REPO" rev-parse HEAD)
mkdir -p "$REPO/backend/node_modules" "$REPO/frontend/node_modules"
echo "fixture: $REPO (c0=$C0)"

echo "═══ T1 normal push reaches redeploy.sh (no skip despite HEAD==NEW_SHA) ═══"
C1=$(pushcommit "$REPO/frontend/src/app.ts" "fe1" "c1 frontend")
rc=$(run_driver auto "$C0" "$C1")
t  "exit 0"                            test "$rc" = "0"
t  "driver delegated to the pipeline"  grep -q "deploy pipeline" "$OUT"
tn "old skip banner GONE"              grep -q "already at origin/main" "$OUT"
t  "redeploy.sh ran (atomic swap)"     grep -q "swapped in atomically" "$OUT"
t  "VM HEAD == C1"                     test "$(git -C "$REPO" rev-parse HEAD)" = "$C1"
t  "state file == C1"                  test "$(state)" = "$C1"
tn "no staging leftovers"              test -e "$REPO/frontend/dist.next" -o -e "$REPO/frontend/dist.prev"

echo "═══ T2 genuine rerun of the same push is safe (freshness skip) ═══"
rc=$(run_driver auto "$C0" "$C1")
t  "exit 0"                        test "$rc" = "0"
t  "delegated again"               grep -q "deploy pipeline" "$OUT"
t  "frontend recognized fresh"     grep -q "already built from" "$OUT"
t  "nothing to deploy"             grep -q "nothing to deploy" "$OUT"
tn "no rebuild happened"           grep -q "swapped in atomically" "$OUT"
t  "state still C1"                test "$(state)" = "$C1"

echo "═══ T3 backend push deploys; rerun is idempotent + healthy ═══"
C2=$(pushcommit "$REPO/backend/index.ts" "be1" "c2 backend")
rc=$(run_driver auto "$C1" "$C2")
t  "exit 0"                        test "$rc" = "0"
t  "backend rebuilt + healthy"     grep -q "backend rebuilt, restarted and healthy" "$OUT"
tn "frontend NOT rebuilt"          grep -q "swapped in atomically" "$OUT"
t  "state still C1"                test "$(state)" = "$C1"
rc=$(run_driver auto "$C1" "$C2")
t  "rerun exit 0"                  test "$rc" = "0"
t  "backend idempotent + healthy"  grep -q "backend rebuilt, restarted and healthy" "$OUT"
tn "frontend still NOT rebuilt"    grep -q "swapped in atomically" "$OUT"

echo "═══ T4 old-run rerun while origin/main moved → deploys CURRENT main ═══"
C3=$(pushcommit "$REPO/frontend/src/app.ts" "fe2" "c3 frontend")
rc=$(run_driver auto "$C1" "$C2")   # stale args: NEW=C2, origin/main=C3
t  "exit 0"                        test "$rc" = "0"
t  "reset landed on current main"  test "$(git -C "$REPO" rev-parse HEAD)" = "$C3"
t  "frontend rebuilt for C3"       grep -q "swapped in atomically" "$OUT"
t  "state == C3"                   test "$(state)" = "$C3"

echo "═══ T5 --full through the driver still forces rebuild + npm ci ═══"
rc=$(run_driver --full)
t  "exit 0"                        test "$rc" = "0"
t  "mode FULL"                     grep -q "mode: FULL" "$OUT"
t  "npm ci ran"                    grep -q "npm ci" "$OUT"
t  "atomic swap happened"          grep -q "swapped in atomically" "$OUT"
t  "state == C3"                   test "$(state)" = "$C3"

echo "═══ T6 structural checks ═══"
tn "skip banner gone from driver source" grep -q "already at origin/main" "$REPO/deploy/gha-deploy-remote.sh"
t  "bash -n on driver"             bash -n "$REPO/deploy/gha-deploy-remote.sh"
t  "bash -n on redeploy.sh"        bash -n "$REPO/deploy/redeploy.sh"
t  "delegation is unconditional"   bash -c 'test "$(grep -c "bash deploy/redeploy.sh" "'"$REPO"'/deploy/gha-deploy-remote.sh")" = "1"'

echo "═══ T7 freshness unprovable → frontend force-rebuilt ═══"
# 7a. Empty diff range (baseline == NEW) with NO state + NO dist: the empty
#     range proves nothing → the frontend must be rebuilt, not trusted.
rm -rf "$REPO/frontend/dist" "$REPO/deploy/.last-frontend-sha"
rc=$(run_driver auto "$C3" "$C3")
t  "empty range exit 0"           test "$rc" = "0"
t  "empty range force message"    grep -q "freshness unprovable" "$OUT"
t  "empty range atomic swap"      grep -q "swapped in atomically" "$OUT"
t  "state == C3 (written)"        test "$(state)" = "$C3"

# 7b. README/docs-only push, still no state + no dist: the diff alone says
#     "nothing to deploy", but an unprovable frontend must NOT be swallowed by
#     that shortcut — it is rebuilt anyway (staleness from outside the window).
C4=$(pushcommit "$REPO/README.md" "docs" "c4 docs only")
rm -rf "$REPO/frontend/dist" "$REPO/deploy/.last-frontend-sha"
rc=$(run_driver auto "$C3" "$C4")
t  "README-only exit 0"           test "$rc" = "0"
t  "README-only reset to C4"      test "$(git -C "$REPO" rev-parse HEAD)" = "$C4"
t  "docs push force message"      grep -q "freshness unprovable" "$OUT"
tn "nothing-to-deploy NOT printed" grep -q "nothing to deploy" "$OUT"
t  "docs push atomic swap"        grep -q "swapped in atomically" "$OUT"
t  "state == C4"                  test "$(state)" = "$C4"

# 7c. Garbage state file (not a commit) is as good as no state → a rebuild is
#     forced even though the diff only touches the backend and dist exists.
C5=$(pushcommit "$REPO/backend/index.ts" "be2" "c5 backend only")
printf '%s\n' "garbage-not-a-sha" > "$REPO/deploy/.last-frontend-sha"
rc=$(run_driver auto "$C4" "$C5")
t  "garbage-state exit 0"         test "$rc" = "0"
t  "garbage treated unprovable"  grep -q "freshness unprovable" "$OUT"
t  "garbage state atomic swap"    grep -q "swapped in atomically" "$OUT"
t  "state == C5"                  test "$(state)" = "$C5"

# 7d. State is a VALID but STALE commit — matching neither the baseline nor the
#     target (dist drifted out-of-band) → rebuild rather than trust the diff.
C6=$(pushcommit "$REPO/frontend/src/app.ts" "fe3" "c6 frontend")
printf '%s\n' "$C1" > "$REPO/deploy/.last-frontend-sha"
rc=$(run_driver auto "$C5" "$C6")
t  "stale-state exit 0"        test "$rc" = "0"
t  "stale-state atomic swap"    grep -q "swapped in atomically" "$OUT"
t  "state advanced to C6"       test "$(state)" = "$C6"

echo ""
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = "0" ]
