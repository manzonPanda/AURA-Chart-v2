# AURA Chart — IG DAX Candlestick Chart

A working candlestick chart that streams real **IG Markets** historical DAX data through a
small Hono + TypeScript API into a React + **CandleKit** (on **Lightweight Charts**) dashboard,
with **EMA 20** and **EMA 50** overlays.

```
IG Markets REST API
        │
        ▼
   Hono Backend   (backend/src — auth + /prices + normalization)
        │
        ▼
   React Frontend  (frontend/src — CandleKit <ChartView>)
        │
        ▼
    CandleKit  →  Lightweight Charts
        │
        ▼
   DAX candlestick chart — 1m & 3m (realtime via Lightstreamer)
```

> The frontend **never** talks to IG and **never** holds IG credentials. It only calls our
> own Hono API. Credentials live exclusively in backend environment variables.

---

## What's implemented

- **Backend (Hono + TypeScript, Node built-in `fetch`)**
  - IG authentication with RSA/ECB/PKCS1 password encryption (`GET /session/encryptionKey`
    → `POST /session` → captures `CST` + `X-SECURITY-TOKEN`), cached per process and
    re-authenticated transparently once if a session expires.
  - `GET /api/candles` proxies IG `/prices/{epic}`, normalizes the IG response into a clean
    internal candle type, and never leaks IG structures or secrets to the client.
  - Config-driven IG EPIC (`IG_DAX_EPIC`) so no hardcoded/wrong EPIC; `epic` can also be
    passed as a query param.
  - Full error handling: invalid creds, auth failure, invalid EPIC, invalid resolution,
    IG rate limits, malformed responses, empty responses, network failures — all mapped to
    sensible HTTP statuses with secret-free messages.
  - `GET /api/health` for status checks.
- **Frontend (React + TypeScript + Vite)**
  - `ChartView` from `@getcandlekit/charts/react` (v0.1.0) on Lightweight Charts v5.
  - Candlestick chart, dark trading-dashboard theme, responsive + auto-resizes with the
    window (CandleKit's built-in ResizeObserver handling).
  - Timeframe selector: **1m · 3m** — 1m is IG's native minute resolution; 3m is
    aggregated server-side from 1-minute candles (epoch bucket floor(t/180)*180).
  - **EMA 9 / EMA 20 overlays computed by the PineTS engine** (Pine Script
    `ta.ema()`) — see "PineTS indicator engine" below. Overlay styling
    (period/color/width/enabled) is frontend-only and persisted in
    `localStorage` under `aura.ema.settings`; nothing indicator-related is
    written to the database.
  - OHLC/change/volume readout of the latest candle, last-updated info, manual refresh and
    optional 30s auto-refresh.
  - **NO indicators by design** (no EMA 20/50/200, no crossovers) — indicators are a
    separate future task. The chart renders pure candlesticks + tick volume.

---

## Project structure

```
.
├── package.json              # root scripts (dev, setup, typecheck)
├── .env.example              # template for backend credentials
├── backend/
│   ├── .env.example          # copy to backend/.env
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── config.ts         # env-driven config (IG_* only here)
│       ├── index.ts          # Hono app + @hono/node-server bootstrap
│       ├── types/candle.ts   # normalized Candle + API response types
│       ├── ig/
│       │   ├── auth.ts       # encryption + session creation
│       │   ├── client.ts     # HTTP client, session cache, 401 retry, error cls.
│       │   ├── historical.ts # /prices fetch + IG→Candle normalization
│       │   ├── errors.ts     # typed errors + safe HTTP mapping
│       │   └── types.ts      # IG response types + supported resolutions
│       └── routes/candles.ts # GET /api/candles handler
└── frontend/
    ├── index.html
    ├── vite.config.ts        # dev proxy /api → :8787
    ├── package.json
    ├── tsconfig*.json
    └── src/
        ├── App.tsx
        ├── main.tsx
        ├── styles.css        # dark trading-dashboard theme
        ├── types/candle.ts   # shared candle shape
        ├── config/timeframes.ts
        ├── services/api.ts   # only talks to our Hono API
        └── components/TradingChart/
            ├── TradingChart.tsx
            └── OHLCReadout.tsx
```

---

## 1. Configure the IG credentials

1. Copy the template into the backend and fill it in:

   ```bash
   cp backend/.env.example backend/.env
   ```

2. Edit `backend/.env` (values only live server-side):

   ```env
   IG_API_KEY=your-ig-api-key
   IG_USERNAME=your-ig-login
   IG_PASSWORD=your-ig-password
   IG_ACCOUNT_ID=optional-account-id
   IG_BASE_URL=https://demo-api.ig.com/gateway/deal   # or live https://api.ig.com/gateway/deal
   IG_DAX_EPIC=INDEX:DAX                               # set your account's DAX EPIC
   PORT=8787
   ```

   > **Do not** prefix these with `VITE_`. Vite would bundle them into the browser.
   > `backend/.env` is git-ignored.

3. The DAX EPIC is account-specific — IG does **not** use a plain `"DAX"`. Common examples
   are `INDEX:DAX`, `UA.D.DAX.CASH.IP` (cash) and `IX.D.DAX.IFD.IP` (futures CFD). Set the
   one for your account in `IG_DAX_EPIC` (or pass `?epic=...` per request).

## 2. Install

```bash
npm run setup        # installs root + backend + frontend
```

## 3. Run the backend

```bash
npm run dev:backend
# or: cd backend && npm run dev
```

Starts on **http://localhost:8787**. Check it with `http://localhost:8787/api/health`.

## 4. Run the frontend

```bash
npm run dev:frontend
# or: cd frontend && npm run dev
```

Opens on **http://localhost:5173**. Vite proxies every `/api/*` call to the backend, so the
browser stays single-origin.

## Run both at once

```bash
npm run dev         # backend (:8787) + frontend (:5173) together
```

---

## API

```
GET /api/candles?epic=<EPIC>&resolution=MINUTE_5&limit=500
```

| param        | required | notes                                                    |
| ------------ | :------: | -------------------------------------------------------- |
| `epic`       | no       | falls back to `IG_DAX_EPIC`                              |
| `resolution` | yes      | chart resolution (`MINUTE` = 1m, `MINUTE_3` = aggregated 3m) |
| `limit`      | no       | 1–500 candles (IG page-size cap, default 500)            |

```jsonc
// 200
{ "epic": "INDEX:DAX", "resolution": "MINUTE", "count": 500, "candles": [
  { "ts": 1724745900000, "open": 18342.0, "high": 18365.0, "low": 18330.0, "close": 18358.5, "volume": 120 }
] }
```

Errors return `{ error, code }` with a useful HTTP status and never include secrets:
`EPIC_MISSING` (400), `INVALID_RESOLUTION` (400), `IG_EPIC_NOT_FOUND` (404), `IG_RATE_LIMITED`
(429), `IG_NOT_CONFIGURED` (500), `IG_AUTH_FAILED` / `IG_UNREACHABLE` / `IG_UPSTREAM_ERROR` (502).

---

## Real-time streaming (IG Lightstreamer)

Live candles are streamed — **no REST polling for realtime**:

```
IG Live  →  IG Lightstreamer  →  Hono backend  →  tick/price stream
        →  server-side candle aggregation  →  WebSocket /ws  →  React
        →  CandleKit / Lightweight Charts  (series incremental updates)
```

- **`backend/src/streaming/igStream.ts`** — IG Lightstreamer client. Authenticates with
  the `CST` / `X-SECURITY-TOKEN` obtained from the existing IG login (never hardcoded),
  connects to the Lightstreamer endpoint IG returns in the `/session` body, and subscribes
  to the `CHART:<EPIC>:TICK` item in DISTINCT mode (fields `BID OFR LTP LTV TTV UTM`).
- **`backend/src/streaming/aggregator.ts`** — server-side candle aggregation into the
  forming candle per timeframe (1m · 3m):
  `high = max(high, price)`, `low = min(low, price)`, `close = latest price`; the candle
  is rolled over automatically at each timeframe boundary.
- **`backend/src/streaming/realtimeService.ts`** — one shared Lightstreamer connection,
  fans every tick into all aggregators, and pushes `{ type: "candle", ... }` frames over
  the `/ws` WebSocket. Status frames are truthful — they mirror the ACTUAL IG
  Lightstreamer state (`LIVE` / `CONNECTING` / `RECONNECTING` / `DISCONNECTED`) and carry
  `lastTickAt`; a connected socket with no fresh ticks is displayed as
  **`CONNECTED · NO TICKS`**, never a faked "LIVE" (a 30 s status heartbeat keeps the
  tick counters/ages fresh without polling IG).
- **`frontend/src/services/realtime.ts`** — the browser WebSocket client (`ws://…/ws`,
  proxied by Vite). It never sees IG credentials; the browser is a pure relay consumer.
  Reconnects with capped exponential backoff.
- **`TradingChart.tsx`** — initial history from the preserved REST endpoint
  (`GET /api/candles`), then incremental updates only: `controller.updateBar(...)` per
  candle frame (never a full series replacement). After every history `setData` the
  latest live candle is re-applied (CandleKit bus `data` event) so the
  historical→live handoff never drops the forming bar. No indicators attached.
- **Reconnection & safety** — the backend self-heals on Lightstreamer disconnects and
  expired sessions; auth retries are gated by the existing 90-second failure cooldown.
  Secrets never reach the browser and never appear in logs.

### Verify streaming without touching the chart

```bash
npm run ig:stream-check          # from the repo root
# or: cd backend && npm run ig:stream-check
```

Prints a secret-free verdict like:

```text
gateway : api.ig.com
authentication: PASS
lightstreamer: CONNECTED
subscription: CHART:IX.D.DAX.IGM.IP:TICK
ticks received: 15
latest price: 26325.8
status: STREAMING
RESULT  : SUCCESS
```

Env knobs: `IG_STREAM_CHECK_TICKS` (default 20), `IG_STREAM_CHECK_WAIT_MS` (default 20000).

---

## What remains (next phase)

Not implemented yet, as requested:

- **Further indicators** (SMA/RSI/MACD/ATR, crossovers, plotshapes) — the
  PineTS engine is in place for them, but only the EMA use case is wired in
  this phase. The user-facing Pine Script editor / paste-an-indicator flow is
  a later phase too.
- **Supabase/PostgreSQL historical storage**, backtesting, trading signals, multiple
  instruments/accounts.
- No Docker, TimescaleDB, Redis, Kafka, auth system, or extra state management — kept small
  and easy to read on purpose.

## PineTS indicator engine

EMA 9/20 are computed by **PineTS** (`pinets`), LuxAlgo's Pine Script® v6
runtime, through a thin generic adapter:

```
IG Lightstreamer
      ↓
1m canonical candles          (unchanged backend persistence)
      ↓
Supabase
      ↓
AURA selected timeframe       (1m native / 3m aggregation — unchanged rules)
      ↓
PineIndicatorEngine           frontend/src/services/pineEngine.ts
      ↓
PineTS                        npm pinets — Pine Script ta.ema()
      ↓
EmaBridge                     frontend/src/components/TradingChart/EmaBridge.tsx
      ↓
Lightweight Charts / CandleKit
```

Key properties:

- **Authoritative truth only.** The engine's input is built by the same
  `effectiveCloseSeries(...)` reconciliation the chart already uses — the WS
  server-truth candle REPLACES the forming bucket's close. The cosmetic
  rAF/glide price is never an input. On bucket rollover the closed candle
  lands in the series, PineTS recomputes the whole history, and the new forming
  candle continues from there. Background tabs stay safe: a stale snapshot is
  re-anchored by the next full server snapshot, and an unchanged authoritative
  close stream short-circuits (data-signature guard) instead of recomputing.
- **3m is calculated from 3m candles.** The engine receives the SELECTED
  timeframe's bars — never the 1m EMA.
- **Generic, not EMA-specific.** Indicators are registry entries in
  `frontend/src/services/pineIndicators.ts` (Pine source + `plot()` key +
  `input.*` bindings). Future `ta.sma/rsi/macd/atr/crossover/crossunder`,
  `plotshape`, `hline` support is a registry change, not an engine change.
  Only `ta.ema()` is wired in this phase.
- **Equivalence oracle.** `services/ema.ts` is kept as the permanent
  reference/fallback implementation. `frontend/tests/pineEquivalence.test.mjs`
  proves PineTS `ta.ema()` == `ema.ts` for EMA 9/20, 1m/3m, insufficient
  history, forming candle, rollover, timeframe switching, period switching and
  background-tab reconciliation (max Δ ≈ 5e-11, tolerance 5e-9 — PineTS rounds
  to 10 decimals internally).
- **Performance.** Each distinct parameter set compiles exactly once (PineTS
  bakes `input.*` at transpile time); runs reuse the compiled artifact and a
  memoized result keyed by (indicator, params, data-signature); the PineTS
  runtime is rebuilt only when the authoritative candle series actually
  changes; nothing runs from rAF. Measured ≈ 10–12 ms per full recompute at
  500 bars per EMA.
- **No server/DB footprint.** No EMA columns, no EMA tables, no backend
  changes; settings stay in `localStorage` (`aura.ema.settings`).

### License

PineTS is dual-licensed: **AGPL-3.0-only** or a paid LuxAlgo commercial
license. AURA uses it under AGPL-3.0 within its current personal/internal
usage scope — see `THIRD-PARTY-NOTICES.md` for the exact obligations and when
a commercial license (or AGPL source release) would become mandatory. Nothing
in this integration modifies or works around PineTS or its licensing.

## Historical prices & IG pagination facts (verified 2026-08)

- `GET /prices/{epic}` (v3) **requires `pageSize` alongside `max`**. With `max` alone IG
  returns its default 20-point page **from the oldest end of the history window** — which
  is exactly the "chart loads only 20 ancient candles" bug.
- `pagenumber` and `to` are ignored by v3 → only **500 points per (epic,
  resolution) per request** is the hard ceiling. The chart serves only **1m** (up to
  500 native 1-minute candles) and **3m** (up to ~166 candles aggregated from the
  single latest 500-point 1-minute fetch; IG cannot page further back, so 3m history
  is the maximum IG exposes in one call and the realtime stream extends it forward).
- Every historical response is charged against IG's **daily historical-data allowance**
  (live accounts: 10,000 points/day). When exhausted IG returns 403
  `error.public-api.exceeded-account-historical-data-allowance`, which the backend maps to
  the truthful `429 IG_ALLOWANCE_EXHAUSTED` (NOT an auth failure) — the realtime stream is
  unaffected by the allowance.

## Verification scripts

```bash
node scripts/verify-timeframes.mjs   # count/order/gaps/freshness for both timeframes (~500 allowance points)
node scripts/ws-check.mjs            # captures live WS frames: status/candle updates/rollovers (browser path, no allowance)
cd backend && npx tsx src/scripts/agg-test.ts  # offline unit test of the 3m aggregation
cd backend && npm run ig:prices-check  # probes IG /prices param behaviour
cd backend && npm run ig:ts-check      # REST-vs-stream timestamp handshake check
cd backend && npm run ig:stream-check  # Lightstreamer connectivity verdict
cd backend && npx tsx src/scripts/raw-probe.ts  # raw IG status/errorCode/allowance for one /prices call
```
