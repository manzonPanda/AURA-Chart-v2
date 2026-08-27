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
   DAX candlestick chart + EMA 20 / EMA 50
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
  - Timeframe selector: **1m · 5m · 15m · 1h · 4h · 1D** — each mapped to a real IG
    resolution (`MINUTE`, `MINUTE_5`, `MINUTE_15`, `HOUR`, `HOUR_4`, `DAY`).
  - OHLC/change/volume readout of the latest candle, last-updated info, manual refresh and
    optional 30s auto-refresh.
  - **EMA 20 + EMA 50** using CandleKit's built-in EMA `calculate` (registered as two
    distinct named indicators). Because CandleKit keys indicators by name, the built-in
    `EMA` is cloned into `EMA20`/`EMA50` reusing its exact calculation — no hand-rolled math.
    EMAs recompute automatically whenever new candle data is delivered.

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
            ├── indicators.ts  # EMA20/EMA50 via CandleKit registry
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
| `resolution` | yes      | IG resolution (`MINUTE_5`, `HOUR`, `DAY`, …)             |
| `limit`      | no       | 1–500 candles (IG page-size cap, default 500)            |

```jsonc
// 200
{ "epic": "INDEX:DAX", "resolution": "MINUTE_5", "count": 500, "candles": [
  { "ts": 1724745900000, "open": 18342.0, "high": 18365.0, "low": 18330.0, "close": 18358.5, "volume": 120 }
] }
```

Errors return `{ error, code }` with a useful HTTP status and never include secrets:
`EPIC_MISSING` (400), `INVALID_RESOLUTION` (400), `IG_EPIC_NOT_FOUND` (404), `IG_RATE_LIMITED`
(429), `IG_NOT_CONFIGURED` (500), `IG_AUTH_FAILED` / `IG_UNREACHABLE` / `IG_UPSTREAM_ERROR` (502).

---

## What remains for live streaming (next phase)

Not implemented yet, as requested:

- **Live prices / real-time candles** — switch the data source from history-only polling to
  IG's Lightstreamer streaming feed, or a shorter-poll subscription, and feed
  `controller.updateBar(...)` / `onBar()` so candles + EMAs update tick-by-tick.
- **EMA crossover detection** and more indicators (EMA 200 is a one-line config change:
  add another clone in `frontend/src/components/TradingChart/indicators.ts`).
- **Supabase/PostgreSQL historical storage**, backtesting, trading signals, multiple
  instruments/accounts.
- No Docker, TimescaleDB, Redis, Kafka, auth system, or extra state management — kept small
  and easy to read on purpose.
