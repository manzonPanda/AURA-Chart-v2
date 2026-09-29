# P3 AUDIT REPORT — MT5 Historical Trade Overlay (READ-ONLY)

**Scope:** Read-only investigation to prepare the P3 implementation plan for displaying
historical MT5 trades on the AURA Chart v2 candles. No source, test, or configuration
files were modified. No P3 code was implemented.

**Date:** 2026-09-22 · **Auditor:** Cline · **Mode:** READ-ONLY

**Workspace note (important):** the task brief named `C:\Project Trading\` and
`MyTradingDashboard5`. The actual on-disk workspace is
`C:\Users\jakejamesmanzon\Downloads\Project Trading\` and the dashboard project is
**`MyTradingDashboard2`** (same four subfolders as briefed: `pythonMt5`, `aura-backend`,
`trading-dashboard`, `db`). All findings below use the real paths.

---

## A. Exact files inspected

**MyTradingDashboard2**
- `pythonMt5/mt5_api.py` — the MT5 bridge (Flask + Flask-SocketIO, watcher threads, trade emission, screenshot upload, `/api/history`)
- `aura-backend/server.js` — Express app; auth middleware; storage routes; behavior engine; registers overlay routes
- `aura-backend/src/db/trading-overlay.js` — P1 read-only trading API (3 GET routes, fixed SQL, column whitelists)
- `aura-backend/src/realtime/events.js` — in-process SSE change bus (`publishChange` / `subscribeChanges`, served by `GET /api/events`)
- `db/schema/04_trades.sql` — `public.trades` DDL (28 columns, indexes, partial unique ticket index)
- `trading-dashboard/src/app/services/mt5-time.service.ts` — **the repo's MT5-timezone authority** (Europe/Helsinki EET/EEST, DST-aware)
- `trading-dashboard/src/app/services/aura-api.service.ts` — trade row persistence (`time_open_ph` derived from `time_open`)
- `trading-dashboard/src/app/dashboard/dashboard.component.ts` (time-related sections)
- `trading-dashboard/src/app/connection-status/connection-status.component.ts` (Socket.IO client usage)

**AURA-Chart v2**
- `backend/src/index.ts` — Hono app assembly, route mounting, `/ws` WebSocketServer relay
- `backend/src/config.ts` — `dashboard.baseUrl` (`DASHBOARD_API_URL`, default `http://localhost:5001`)
- `backend/src/routes/trading.ts` — P2 same-origin proxy (`/api/trading/*`, allowlisted paths + query params)
- `backend/src/services/dashboardClient.ts` — P2 server-to-server client; `DashboardTrade` contract
- `backend/src/capital/time.ts` — Capital.com timestamp rules (`snapshotTimeUTC` = tz-less → parsed as UTC)
- `backend/src/market/instruments.ts` — instrument registry (GOLD active; DAX/legacy-Gold/Silver archive)
- `backend/src/streaming/timeframes.ts` — `MINUTE_1` canonical; `MINUTE_3` derived on read; buckets 60/180 s
- `backend/src/routes/candlesDb.ts`, `backend/src/db/candleStore.ts` — archive reads; `bucket_time` = ISO timestamptz
- `frontend/src/services/tradingApi.ts` — P2 frontend client + `TradeRecord` (verified: **not yet consumed by any UI**)
- `frontend/src/types/candle.ts` — `Candle.ts` = epoch-millisecond **UTC bucket start**
- `frontend/src/services/realtime.ts` — browser WS client for `/ws` (candles only)
- `frontend/src/components/TradingChart/TradingChart.tsx`, `frontend/src/App.tsx`
- `AURA_CHART_TRADING_OVERLAY_AUDIT.md` — prior P0/P1 audit (cross-checked)

---

## B. Current architecture / data flow

```
MT5 terminal (Windows)
  └─ pythonMt5/mt5_api.py (Flask+Socket.IO; watcher threads poll @100 ms behind _MT5_TRADE_LOCK)
       ├─ Socket.IO events → Angular trading-dashboard
       │     trade_opened / trade_closed / pending_order / account_info
       │     Angular writes public.trades:
       │       time_open / time_close   = MT5 server wall clock, verbatim (naive, no tz)
       │       time_open_ph/time_close_ph = derived via mt5ServerTimeToPhilippine()
       │                                    (Europe/Helsinki → Asia/Manila, DST-aware)
       └─ HTTP → aura-backend (Express, default port 5000)
             signs in via /api/auth/sign-in (service account, HMAC session)
             uploads trade screenshots; upserts trade_screenshots via /api/db/query
             + P1 read-only overlay API (src/db/trading-overlay.js):
                 GET /api/trading/accounts
                 GET /api/trading/accounts/:accountId/trades
                 GET /api/trading/accounts/:accountId/state   (live money = null)

AURA-Chart v2 backend (Hono; DASHBOARD_API_URL default http://localhost:5001)
  ├─ P2 proxy /api/trading/* (routes/trading.ts) → DashboardClient
  │     Bearer forwarded opaquely; fixed allowlist; 401/403/400/500 preserved; 502/504 normalised
  ├─ Candle path (independent): Capital.com WS → MINUTE_1 persisted to ohlc_candles
  │     (Oracle PostgreSQL via pgPool); MINUTE_3 derived on read
  └─ /ws WebSocketServer relay → browser (candle/status frames ONLY)

Browser
  ├─ tradingApi.ts (P2) → same-origin /api/trading/* — implemented but UNUSED by any UI today
  └─ realtime.ts → /ws candle stream
```

Security/boundary facts P3 must preserve:
- Browser never reaches aura-backend, its PostgreSQL, or MT5 directly.
- No Supabase at runtime in AURA Chart (PostgreSQL is the only persistence path).
- P2 added no new realtime transport — P3 must not silently add one.

## C. MT5 timestamp evidence

1. **`pythonMt5/mt5_api.py`**
   - Line ~375: `# Keep time in MT5 UTC (no local conversion)` — but the code
     `datetime.fromtimestamp(pos.time, tz=timezone.utc)` merely renders MT5's
     epoch as UTC **wall clock without shifting it**. `pos.time` from the MetaTrader5
     Python API is seconds since epoch expressed in **broker server time**, not true UTC.
   - `history_deals_get()` deals render `d.time` the same way (line ~409).
   - `/api/history` renders open positions identically (line ~647).
   - **Consequence:** the bridge treats server wall-clock as if it were UTC. The
     comment is misleading; the values are broker time.
2. **`db/schema/04_trades.sql` lines 8–10** — `time_open`/`time_close` are
   "MT5 server time (`timestamp without time zone`)" stored **verbatim, no UTC
   conversion**; `time_open_ph`/`time_close_ph` are app-derived Asia/Manila.
3. **`aura-backend/src/db/trading-overlay.js` lines 35–38** — confirms storage is
   "MT5 SERVER WALL-CLOCK … no UTC conversion", and `from`/`to` filters compare
   against that same server wall clock (a zone designator on `from`/`to` is
   accepted syntactically but **its offset is deliberately NOT applied**).
4. **`trading-dashboard/src/app/services/mt5-time.service.ts`** — the authoritative
   in-repo declaration:
   - `MT5_SERVER_TIME_ZONE = 'Europe/Helsinki'` (The5ers MT5 server = EET/EEST).
   - Winter: EET = UTC+2 (→ Manila +6h); Summer: EEST = UTC+3 (→ Manila +5h).
   - `mt5ServerTimeToPhilippine()` resolves the offset per timestamp via
     `Intl` with a fixed-point refinement pass (DST-safe, no hard-coded +5/+6).

**Conclusion (evidence-based, not guessed):** MT5 trade timestamps are **broker
server wall clock in Europe/Helsinki (EET/EEST)** — NOT UTC, despite the
misleading bridge comment. The currently stored DB columns are the verbatim
server wall clock.

## D. Verified UTC offset / exact measurement still required

- **Documented offset (repo evidence):** UTC+2 (EET, winter) / UTC+3 (EEST,
  summer), i.e. server = UTC + offset, per `mt5-time.service.ts` for The5ers.
- **Uncertainty / measurement still required before P3 goes live:**
  1. `Europe/Helsinki` is the assumption encoded for The5ers; if any account
     runs on a broker with a fixed-offset or other-UTC server (common: many
     MT5 brokers are UTC+2/+3 fixed or UTC+0), the offset differs per broker.
     The offset is effectively **per MT5 account/server**, not global.
  2. **Recommended runtime verification (read-only method):** compare one fresh
     trade's `pos.time` (server wall clock, via the bridge) against the true
     UTC instant of the same event captured at submission time — or compare
     `mt5.symbol_info_tick(symbol).time` polled simultaneously with the local
     `time.time()`. The measured delta, snapped to the nearest hour, is the
     actual server offset; repeating across a DST boundary date confirms EET/EEST
     switching vs fixed offset.
  3. Until measured, P3 must treat the offset as **configuration per account**
     (default `Europe/Helsinki`) and surface unverified-offset risk in the UI.
- Note also the bridge already emits "UTC-labelled" strings; any consumer that
  trusts that label (e.g. Python `datetime.fromtimestamp(..., tz=timezone.utc)`)
  inherits a hidden +2/+3 h error.

## E. Timestamp → candle mapping specification

**Candle time base (AURA Chart, verified):** `Candle.ts` is epoch-ms **UTC** of the
bucket **start**; persisted `bucket_time` is ISO timestamptz (true UTC);
`MINUTE_1` bucket = 60 s, `MINUTE_3` = 180 s, both aligned to
`floor(epoch / bucket) * bucket` (the 3 m grid is a pure multiple of the 1 m grid,
so a single conversion serves both).

**Conversion (server wall clock → UTC epoch-ms):**
```
utcMs = Date.UTC(y, mo-1, d, h, mi, s)            // parse naive time_open/time_close as UTC wall clock
      - zoneOffsetMs('Europe/Helsinki', utcMs)     // subtract EET/EEST offset in force at that instant
                                                    // (two-pass fixed point, as mt5-time.service.ts does)
candleTs = floor(utcMs / bucketMs) * bucketMs      // bucket-start alignment, works for 1m and 3m
```

**Open vs close time — explicit decision:**
- **Entry marker:** map by `time_open` (bucket-start aligned).
- **Exit marker:** map by `time_close` (same rule).
- **Trade line / duration band:** use BOTH — a segment from the open-time candle
  to the close-time candle. For **open trades** (`time_close IS NULL`) draw to the
  current live candle with a "live" style.
- Do not derive one from the other; `held` (text) is not machine-parseable enough.

**DST/timezone risks:**
- EET→EEST transitions (last Sundays of March/October) shift the offset by 1 h;
  per-timestamp zone resolution (not a constant offset) is mandatory.
- Existing historical rows store verbatim server time — an offset applied with the
  *current* DST regime would misplace older trades by 1 h; always resolve the
  offset **at the trade's own timestamp**.
- Ambiguous/Nonexistent local times at DST boundaries (02:00–03:00 in late March)
  are an accepted edge: one-hour misplacement on two nights per year, documented.
- Never use `Date.parse` on the naive strings (local-tz hazard — same bug class
  `capital/time.ts` documents and guards).

## F. Symbol normalization table

Evidence gathered:
- AURA Chart instruments (backend/src/market/instruments.ts): active collection =
  **GOLD** (epic literally `"GOLD"`, Capital.com, 2-dec); DAX = legacy archive
  `IX.D.DAX.IGM.IP`; legacy gold `CS.D.CFIGOLD.CFI.IP`; silver `CS.D.CFDSILVER.CMG.IP`.
  `instrumentMetaFor()` does exact-match lookup (after `.trim()`); no alias logic exists.
- Dashboard DB `trades.instrument` stores the raw MT5 symbol verbatim
  (prior audit cites `XAUUSD` as the observed gold value). The dashboard
  frontend contains **no symbol normalization/alias layer** (grep for
  XAUUSD/GOLD/DAX/GER40 in `src/app` produced no hits), and the P1 overlay API
  filters `instrument` by **exact DB value match** (no wildcards/normalisation).
- MT5 symbol names include broker **suffixes** in the wild (e.g. `XAUUSD.m`,
  `GOLD+`); none were observed in this repo's data, but the bridge passes
  `pos.symbol` through untouched.

**Concrete mapping proposal (repository-evidence only; anything else = runtime
discovery, do NOT invent):**

| MT5 trade `instrument` value | AURA Chart epic | Confidence | Basis |
|---|---|---|---|
| `XAUUSD` | `GOLD` | High (data-observed) | Prior audit lists XAUUSD as the stored instrument; GOLD is the only active AURA instrument |
| `GOLD` (broker-native spot gold) | `GOLD` | Medium | Name identity; verify live MT5 symbol list before shipping |
| DAX-related (`DE40`, `GER40`, `DE30`, `DAX40`, …) | `IX.D.DAX.IGM.IP` (legacy archive) | **Low — NOT established** | No MT5 DAX symbol exists anywhere in this repo; mapping must come from live `mt5.symbols_get()` output; note archive candles exist but DAX is not collected |
| Unknown / suffixed (`XAUUSD.m` …) | unmatched → hide or flag | — | Exact-match only; never guess |

**Proposed normalization rule (minimal, evidence-based):**
`strip broker suffix/prefix (`.` / `+` segments) → uppercase → alias table
{`XAUUSD`→`GOLD`, `GOLD`→`GOLD`}. DAX alias keys to be added ONLY after a live
`mt5.symbols_get()` capture from the user's terminal. Unmatched symbols are
filtered out of the overlay with a diagnostics counter, never rendered against
the wrong instrument.

## G. Historical trade overlay data contract

Upstream (P1, already implemented, unchanged): `GET /api/trading/accounts/:accountId/trades`
returns `{ accountId, trades[], pagination }` where each trade (verbatim through
the P2 proxy; `dashboardClient.ts`/`tradingApi.ts` define identical shapes):

```
account_id, ticket, instrument, buy_sell ("Buy"|"Sell"), lots,
price_open, price_close, sl, tp, risk_per_trade, rrr, mfe, mae,
time_open, time_close,            // naive MT5 server wall clock strings
status ("open"|"closed")          // derived server-side: time_close IS NULL
```

**Availability check for the overlay:**
| Overlay need | Available? | Source field |
|---|---|---|
| Entry price | ✔ | `price_open` |
| Exit price | ✔ (closed only; open trades use live candle) | `price_close` |
| Stop loss | ✔ | `sl` |
| Take profit | ✔ | `tp` |
| Direction | ✔ | `buy_sell` |
| Realized P/L | ✔ closed; **floating P/L NOT stored** | `pnl` (DB only) — **not in P1 whitelist**; `rrr` is the R-multiple |
| Trade duration | ✔ derivable | `time_open`→`time_close` (compute in client; `held` is free-text) |
| Volume | ✔ | `lots` |
| MFE/MAE | ✔ | `mfe`, `mae` |

**Missing fields / gaps:**
- `pnl` exists in the DB but is **not in the P1 column whitelist** (`TRADE_COLUMNS`
  in `trading-overlay.js`) — if the overlay must show P/L on markers, P3 needs a
  one-line whitelist addition (this is the only upstream change candidate).
- No `commission`/`swap` in the whitelist (probably fine for the overlay).
- Times are naive server-clock strings — the client must apply Section E conversion.
- `ticket` may be NULL for ~955/2057 legacy rows (partial unique index) — markers
  need a stable key; use `id`? (not whitelisted) → fallback key `time_open+instrument+price_open`.
- No server-side computed entry/exit `ts` — conversion should live in the frontend
  overlay service (single place), keeping P1/P2 contracts untouched.

**Frontend data shape (proposal, consumed by the overlay layer):**
```
interface TradeOverlay {
  key: string;                    // ticket ?? fallback composite
  epic: string;                   // normalized AURA instrument (Section F)
  direction: "Buy" | "Sell";
  entryTs: number;                // epoch-ms UTC bucket start (Section E)
  exitTs: number | null;          // null ⇒ open trade
  entryPrice: number; exitPrice: number | null;
  sl: number | null; tp: number | null;
  lots: number; pnl: number | null; rrr: string | null;
  status: "open" | "closed";
}
```

## H. Proposed frontend integration point

- The overlay must be a **sibling primitive/bridge, exactly like the existing
  pattern**: `GapRegionsPrimitive`, `CandleCountdownPrimitive`, `PineBridge`,
  `WhitespaceBridge` in `frontend/src/components/TradingChart/`. Recommended:
  - `TradeOverlayPrimitive.ts` — canvas primitive rendering entry/exit markers,
    SL/TP tick lines, and the entry→exit band (Lightweight-Charts primitive,
    z-order below price line, hidden during replay).
  - `TradeOverlayBridge.tsx` — React bridge mounting the primitive on the same
    chart instance, fed from a new `frontend/src/services/tradeOverlay.ts`
    service that: fetches via `getTradingTrades()` (P2 client, already typed),
    applies symbol normalization (F) + time conversion (E), and caches per
    (accountId, from/to) window.
- Mount point: `TradingChart.tsx` alongside the existing bridges (props:
  `tradeOverlays?: readonly TradeOverlay[]`, default `undefined` ⇒ zero
  behavior change; App.tsx fetches only when an account is selected / opt-in).
  `tradingApi.ts` is ready to use as-is.
- The overlay must read only from the existing `Candle[]`/timeScale — never
  rewrite candle data, never register a second series (same rule as
  CandleStyleBridge/PineBridge: overlays are never data rewrites).
- Respect replay/whitespace behavior: hide markers outside loaded history;
  re-render on history pagination changes like `closedLedgerBridge`.

## I. Proposed live subscriber integration point (future, not implemented)

- Existing reusable transports, evaluated:
  1. **aura-backend SSE bus** (`src/realtime/events.js` → `GET /api/events`):
     in-process pub/sub keyed by table. A future live subscriber could publish
     `trades` change events — but the P2 boundary has no SSE proxy yet.
  2. **AURA Chart `/ws` relay** (backend/src/index.ts): the natural extension
     point — add a new frame type (e.g. `type: "trade"`) alongside candle
     frames. Reusing this WebSocketServer + `realtime.ts` does NOT violate
     the P2 "no new realtime transport" rule.
  3. **pythonMt5 Socket.IO** — must stay server-side only (browser never
     touches MT5/Socket.IO directly, per the P2 boundary).
- Recommended: **bridge → aura-backend (persist, publish on SSE bus) → AURA
  backend subscribes server-side and relays on `/ws`** — browser stays
  single-transport, auth posture unchanged, and the overlay UI is driven by
  the same `TradeOverlay` shape (G).
- The account-state endpoint already stubs live MT5 money fields as `null`
  "until the later MT5 subscriber phase" — the same phase would fill those.

## J. Risks / ambiguities

1. **Server offset not runtime-measured** — Europe/Helsinki is documented but
   per-broker; must be measured (D) before trusting minute-level alignment.
2. **DST history**: old trades + current-regime offset = 1 h error half the
   year (mitigated by per-timestamp zone resolution).
3. **Bridge comment is misleading** ("Keep time in MT5 UTC") — document the
   truth in P3 code to prevent future "fixes" in the wrong direction.
4. **Symbol mapping only half-evidenced**: XAUUSD→GOLD is data-observed; the
   MT5 DAX symbol is unobserved (needs a live `symbols_get()` capture).
5. **`pnl` not in the P1 whitelist** — overlay P/L display requires a tiny
   aura-backend change, or the overlay shows only `rrr`.
6. **NULL tickets (~955/2057 rows)** — marker key/dedupe stability needs a
   composite fallback key.
7. **`from`/`to` filters compare against server wall clock** — an AURA-side
   UTC window must be converted back to server time before querying, or the
   window is off by 2–3 h.
8. **Open-trade markers** (`time_close IS NULL`) need "extend to now" behavior
   without touching `liveCandle.ts` authority.
9. **3 m candles are derived on read** — align to the same 180 s grid; no 3 m
   series exists to query.
10. **P2 `tradingApi.ts` is unused today** — first UI consumption may surface
    contract drift; validate against the real aura-backend before UI work.

## K. Exact files that would need modification in the future

**AURA-Chart v2 (frontend)**
- `frontend/src/components/TradingChart/TradingChart.tsx` — accept overlay prop, mount bridge
- `frontend/src/components/TradingChart/TradeOverlayPrimitive.ts` (new)
- `frontend/src/components/TradingChart/TradeOverlayBridge.tsx` (new)
- `frontend/src/services/tradeOverlay.ts` (new — fetch + normalize + convert + cache)
- `frontend/src/services/tradingApi.ts` — only if the contract gains fields
- `frontend/src/App.tsx` — account selection / opt-in toggle wiring

**AURA-Chart v2 (backend)**
- `backend/src/routes/trading.ts` + `services/dashboardClient.ts` — only if the contract gains `pnl` or new endpoints
- `backend/src/index.ts` — future `/ws` trade-frame relay (Section I)
- `backend/src/config.ts` — per-account server-timezone config (Section D)

**MyTradingDashboard2 (minimal, only if needed)**
- `aura-backend/src/db/trading-overlay.js` — add `pnl` to `TRADE_COLUMNS`
- `aura-backend/src/realtime/events.js` + `server.js` — future trade-event publish (live phase)
- `pythonMt5/mt5_api.py` — only if a push path replaces polling (live phase)

**Do NOT touch in P3**: P2 auth, candle/streaming pipeline, EMA alert engine, Pine engine.

## L. Recommended P3 implementation order

1. **Measure the server UTC offset** (Section D method); persist as per-account
   config (default `Europe/Helsinki`).
2. **Capture live MT5 symbol list** (`mt5.symbols_get()`) → finalize the symbol
   alias table (Section F), including the DAX question.
3. **Contract check**: run the P2 proxy + P1 API against the real aura-backend;
   decide on the `pnl` whitelist addition (J5).
4. **Frontend `tradeOverlay.ts` service**: fetch → normalize symbols → convert
   times (E) → emit `TradeOverlay[]`; unit-test conversion + normalization
   against the documented offset behavior (mirror existing `frontend/tests/`).
5. **`TradeOverlayPrimitive` + `TradeOverlayBridge`**: entry/exit/SL/TP markers
   and duration band; wire into `TradingChart.tsx` behind an opt-in toggle.
6. **Open-trade behavior**: extend markers to the live candle without touching
   `liveCandle.ts` authority.
7. **(Later phase) Live subscriber**: aura-backend SSE → AURA backend → `/ws`
   trade frames → overlay live updates (Section I).

---

**End of audit.** No source, test, or configuration files were modified in either
project; the only artifact created is this report.




