# Deploying AURA-Chart — Oracle VM (Option A: single origin, no code changes)

The frontend was deliberately built **single-origin**: HTTP calls use the relative
path `/api` (`frontend/src/services/api.ts`) and the WebSocket URL is derived from
the page origin (`frontend/src/services/realtime.ts`, auto-`wss://` under `https:`).
Production therefore needs **zero frontend or backend code changes** — only this
on the VM:

```
                      Oracle VM
Browser ── http(s)://<host>/ ──▶ nginx  ── static files ──▶ /opt/aura/frontend/dist
   │                             :80/:443
   ├── /api/*  ── proxy ──▶ 127.0.0.1:8787   Hono backend (systemd)
   └── /ws     ── ws upgrade ─▶ 127.0.0.1:8787
```

nginx is the only public listener; the raw API stays on loopback.

> Placeholder paths use `/opt/aura` and the `ubuntu` user — adjust to your VM.

---

## 1. Get the repo + build on the VM

`dist/` folders are git-ignored, so build on the VM (or `scp` your local
`frontend/dist` and `backend/dist` — both builds are verified working).

```bash
sudo mkdir -p /opt/aura && sudo chown ubuntu:ubuntu /opt/aura
git clone https://github.com/manzonPanda/AURA-Chart-v2.git /opt/aura
cd /opt/aura
npm run setup                    # installs root + backend + frontend
npm --prefix backend run build   # → backend/dist
npm --prefix frontend run build  # → frontend/dist
```

> Node 24.12.x is required (`engines` in both package.json files).

## 2. Configure the backend

```bash
cd /opt/aura/backend
cp .env.example .env
nano .env
```

Fill in (values live only on the VM, never in the browser or git):

| Variable | Notes |
|---|---|
| `IG_API_KEY`, `IG_USERNAME`, `IG_PASSWORD` | IG LIVE credentials (already proven working) |
| `IG_ACCOUNT_ID` | optional |
| `IG_BASE_URL` | live `https://api.ig.com/gateway/deal` (current setup) |
| `IG_DAX_EPIC` | your account's DAX EPIC |
| `IG_GOLD_EPIC` | optional — Spot Gold CFD (`CS.D.CFIGOLD.CFI.IP`, SGD, 2-decimal); when set the backend streams DAX + Gold concurrently (Gold is capture-only); empty = DAX-only |
| `PORT=8787` | keep |
| `HOST=127.0.0.1` | **add this** — loopback only, nginx is the sole caller |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | candle persistence (leave empty → `/api/candles/db` 503) |

Smoke-test before wiring systemd:

```bash
npm run start                    # Ctrl-C after "IG chart API ready"
curl http://127.0.0.1:8787/api/health
```

## 3. Run the backend under systemd

```bash
sudo cp /opt/aura/deploy/aura-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aura-backend
journalctl -u aura-backend -f    # expect: API ready + Supabase ENABLED
```

Check `ExecStart=/usr/bin/node dist/index.js` — if `which node` differs
(e.g. nvm install), fix the path first.

## 4. nginx

```bash
sudo apt install -y nginx
sudo cp /opt/aura/deploy/nginx-aura.conf /etc/nginx/sites-available/aura.conf
sudo ln -sf /etc/nginx/sites-available/aura.conf /etc/nginx/sites-enabled/aura.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

If you have a domain, set `server_name your.domain` in the config first.

## 5. Firewall (the classic Oracle VM gotcha — two layers)

**Layer 1 — Oracle Cloud console:** VCN → Security List (or NSG) → add
**ingress** rules for TCP `80` (and later `443`) from `0.0.0.0/0`.
Remove any rule that exposes `8787` — it should no longer be public.

**Layer 2 — the VM itself** (Ubuntu images ship with a default REJECT rule):

```bash
sudo iptables -L INPUT --line-numbers --numeric    # find the REJECT line number
sudo iptables -I INPUT <n> -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT <n> -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save                     # persist across reboots
```

(If you use `ufw` instead: `sudo ufw allow 80,443/tcp`.)

## 6. Verify

```bash
curl http://<vm-public-ip>/api/health        # {"ok":true,"configured":true,...}
curl http://<vm-public-ip>/api/candles/db?timeframe=MINUTE_3&limit=5
curl "http://<vm-public-ip>/api/stream/status"
```

Then open `http://<vm-public-ip>/` in a browser:
- chart history loads (from `/api/candles/db`),
- status pill reaches **LIVE** (or `CONNECTED · NO TICKS` outside market hours),
- DevTools → Network → WS shows a `101 Switching Protocols` on `ws://<host>/ws`.

## 7. TLS (recommended once you have a DNS record)

```
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain
```

Certbot rewrites the nginx config (443 + HTTP→HTTPS redirect). **No frontend
change is needed** — `realtime.ts` upgrades to `wss://` by itself as soon as the
page is served over `https:`.

## 8. EMA Reversal Alerts (Web Push)

The server-side alert engine starts on boot; it needs VAPID keys in
`backend/.env` to deliver phone notifications:

```bash
cd /opt/aura/backend
npx web-push generate-vapid-keys     # prints a VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY pair
nano .env                            # add the three VAPID_* values (see .env.example)
```

Runtime state — alert settings, cooldown timestamps, push-subscription
endpoints — lives in `backend/data/*.json` (gitignored, VM-local). No database
migration is involved.

Web Push additionally requires a **secure context**:
- With TLS enabled (section 7) the browser can subscribe over `https:`.
- On plain HTTP the UI truthfully shows "Push needs HTTPS" and the feature is
  inert until you enable certbot.

Device flow: open AURA → **EMA Alert** bell → **Enable push** (browser
permission) → **Send test** to confirm the phone receives it. Alerts only fire
for confirmed reversals on closed 1-minute candles inside 09:30–16:00
America/New_York (Mon–Fri); the display also shows the current Manila
equivalent.

## Updating a deployed VM (automatic since `ea9fd51`+)

`git pull` now **deploys itself** — a versioned git hook rebuilds and restarts
whatever the pull actually touched:

```bash
cd /opt/aura && git pull        # that's it — see the ✅ deploy summary it prints
git config core.hooksPath deploy/githooks   # one-time per clone; enables the hook
```

How it works (`deploy/redeploy.sh`, wired via `post-merge` + `post-rewrite` so
both `git pull` and `git pull --rebase` are covered):

| Pull touched | What happens automatically |
|---|---|
| `backend/**` | `npm ci` if `package*.json` changed → `tsc` build → `sudo systemctl restart aura-backend` → `/api/health` check |
| `frontend/**` | `npm ci` if `package*.json` changed → `vite build` (nginx serves `dist/` from disk — live immediately) |
| only README/docs | nothing — logged as "nothing to deploy" |

Notes:
- Requires passwordless sudo for `systemctl restart aura-backend`
  (`sudo -n systemctl restart aura-backend` must work — true on this VM).
- Full output is appended to `.last-deploy.log` (repo root, gitignored).
- The restart path in the systemd unit assumes the sudoers rule; on a fresh VM
  where `sudo` prompts for a password, run the restart once by hand or add a
  scoped sudoers drop-in.
- Manual override / full rebuild regardless of diff: `npm run deploy`
  (= `bash deploy/redeploy.sh --full`).

## Why no code changes are needed

- `api.ts` → `const API_BASE = "/api"` (relative; resolves against whatever
  origin serves the page — localhost:5173 in dev, the VM in prod).
- `realtime.ts` → `${scheme}://${window.location.host}/ws` with
  `wss` automatically under `https:`.
- The backend's CORS allowlist (`localhost:5173`) is irrelevant in prod:
  same-origin requests never trigger CORS. The `/ws` upgrade handler never
  checked origins in the first place.
- Local dev keeps working exactly as before (`npm run dev` + Vite proxy).

## CI/CD — automatic deploy from GitHub Actions (push to main)

`.github/workflows/deploy.yml` turns every push to `main` into a deploy. The
runner **never builds anything** — it SSHes into the Oracle VM and drives the
VM's own pipeline (`deploy/redeploy.sh` via `deploy/gha-deploy-remote.sh`), so
manual pulls (git hooks) and push deploys share ONE code path.

### Flow

```
push main
  └─ GitHub Actions (concurrency: aura-deploy-production — queued, never parallel)
      ├─ fail fast if required secrets are missing (names printed, never values)
      ├─ SSH key → $RUNNER_TEMP (0600) + pinned host key (SSH_KNOWN_HOSTS)
      └─ ssh "bash -s" -- <deploy/gha-deploy-remote.sh>
          ├─ verify repo + branch main
          ├─ git fetch origin main
          ├─ git reset --hard origin/main   (no hooks fired → one deploy per push;
          │                                  only TRACKED files touched → VM-side
          │                                  .env / backend/.env / data/ / logs preserved)
          ├─ bash deploy/redeploy.sh auto <old> <new>   (or --full via manual run)
          └─ gate: systemctl is-active + loopback /api/health ok:true + HEAD == origin/main
```

`git reset --hard` (instead of `git pull`) is deliberate: it fires no
`post-merge`/`post-rewrite` hooks, so the push-triggered deploy never triggers
a second, duplicate hook deploy. Reruns are safe: an up-to-date `auto` run is a
no-op plus the health gate.

### Required GitHub secrets (repository or `production` environment)

| Secret | Value | Notes |
|---|---|---|
| `SSH_PRIVATE_KEY` | full PEM private key (`-----BEGIN OPENSSH PRIVATE KEY-----` … incl. newlines) | dedicated deploy key; public half in the VM's `~/.ssh/authorized_keys` |
| `SSH_HOST` | Oracle VM public IP / hostname | never echoed to logs |
| `SSH_USER` | `ubuntu` | the VM user that owns the checkout + sudoers rule |

### Optional secrets

| Secret | Default | Purpose |
|---|---|---|
| `SSH_PORT` | `22` | if the VM SSH moved |
| `SSH_KNOWN_HOSTS` | `ssh-keyscan` (TOFU, warns) | **recommended**: pin the host key (`ssh-keyscan -p 22 HOST`) so MITM fails the run |
| `AURA_DEPLOY_PATH` | `/home/ubuntu/apps/AURA-Chart-v2` | override only if the checkout lives elsewhere (this is the path in the committed systemd unit + nginx conf) |
| `HEALTH_URL` | *(skipped)* | extra runner-side check of the public URL (e.g. `http://<vm>/api/health`) — must report `ok:true` |

### Manual run

Actions → **Deploy (Oracle VM)** → *Run workflow*: leaves the diff-driven
behavior as-is, or tick **Force FULL rebuild** to ignore the diff and rebuild
both sides (`redeploy.sh --full`).

### Safety properties

- **No secrets in logs**: only the SSH key ever crosses the boundary; the
  workflow prints secret *names* on failure, never values; GitHub's automatic
  masking is the second layer. IG/Supabase/VAPID/`.env` values never touch GitHub.
- **No concurrent deploys**: `concurrency: aura-deploy-production` with
  `cancel-in-progress: false` — a second push queues and runs after the first
  completes (a running restart is never killed).
- **Idempotent**: rerunning an up-to-date `main` is a no-op + health gate;
  builds are incremental (`npm ci` only when a lockfile changed, per
  `redeploy.sh` diff logic); a failed build aborts BEFORE the restart, so the
  service keeps running the previous healthy release.
- **VM state is never overwritten from GitHub**: `.env`, `backend/.env`,
  `backend/data/`, logs are gitignored/untracked — `git reset --hard` cannot
  touch them.

### First-time setup checklist

1. Push this repo to GitHub; on the VM, `git remote set-url origin <github-url>`
   (or clone to `/home/ubuntu/apps/AURA-Chart-v2`).
2. Generate a dedicated keypair; append the public key to the VM's
   `~ubuntu/.ssh/authorized_keys`.
3. Add the secrets above (repository, or an `environment: production` with
   required-reviewer protection).
4. Grab the host key: `ssh-keyscan -p 22 <SSH_HOST>` → `SSH_KNOWN_HOSTS`.
5. Push to `main` → watch the run; afterwards
   `journalctl -u aura-backend -f` on the VM if anything is off.

