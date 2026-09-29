# AURA Chart v2 — Trading Overlay Feature: READ-ONLY Architecture & Data Audit

**Scope:** A read-only audit of both local projects to determine what data, real-time
mechanisms, and backend surfaces already exist that could support displaying trading
account information directly on the AURA Chart v2 market chart.

**Date:** 2026-09
**Auditor:** Cline
**Mode:** READ-ONLY (no files modified)

---

## 1. EXECUTIVE SUMMARY

### What EXISTS today (usable as-is)

| Capability | Where it lives | Status |
|---|---|---|
| Trading account records (name, number, balances, risk limits, prop firm) | MyTradingDashboard2 PostgreSQL → Table: `accounts` | Available |
| Historical trades (entry/exit, P&L, SL/TP, MFE/MAE, R-ratio) | MyTradingDashboard2 PostgreSQL → Table: `trades` | Available |
| Trade screenshots | MyTradingDashboard2 PostgreSQL → Table: `trade_screenshots` | Available |
| Account risk config (drawdown mode/basis, profit targets, daily loss limits) | On the `accounts` table row itself | Available |
| Local auth (HMAC sessions) | AURA Backend (`/api/auth/*`, `public.sessions`) | Available |
| Row-scoped data API (PostgREST-shaped → local PostgreSQL) | AURA Backend (`POST /api/db/query`) | Available |
| Server-Sent Events change bus | AURA Backend (`/api/events`, `src/realtime/events.js`) | Available |
| Candle persistence (local Oracle PostgreSQL) | AURA Chart v2 Backend (table `ohlc_candles`) | Available |
| Realtime WebSocket candle stream | AURA Chart v2 Backend (`/ws`, Capital.com) | Available |
| MT5 bridge (live trades, closed trades, price updates) | pythonMt5 service (SocketIO on `https://mt5-api.jakemt5.host`) | Available |

### What does NOT exist yet (must be built)

| Gap | Detail |
|---|---|
| No `balance`/`equity`/`daily_p/l` columns | The `accounts` table stores configuration but NO runtime balance/equity. These are only ever available as transient in-memory state on the MT5 Python bridge and never persisted. Must be calculated or fetched live from MT5. |
| No cross-database joins | AURA Chart uses its own PostgreSQL (`aura` DB). The Trading Dashboard uses a separate PostgreSQL instance. There is NO DB link; cross-database SQL joins are unavailable. Data must cross via API. |
| No trade-overlay UI component in AURA Chart | AURA Chart has no existing primitives for drawing trade markers/lines. The Lightweight Charts + CandleKit chart has no trade-overlay layer. Must build from scratch. |
| No account context in AURA Chart | AURA Chart's frontend has no concept of "trading accounts." It only knows market data (instruments, candles). No session/auth currently. |
| No trade REST API on AURA Backend | The AURA backend exposes `/api/db/query` (generic PostgREST-shaped) but no dedicated `/api/trades` or `/api/accounts` REST endpoints. |

---

## 2. DATABASE AUDIT — MYTRADINGDASHBOARD2 POSTGRES

### Source: `db/schema/` directory (17 migration files)

#### 2.1 `public.accounts` — Table: `03_accounts.sql`

**Purpose:** Trading account records (MT5 login accounts, prop-firm challenge accounts).

**Columns & Types (20 columns):**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` PK | NOT NULL | `gen_random_uuid()` | Primary key |
| `name` | `text` | NOT NULL | — | Human-readable account name |
| `account_number` | `text` | NULL | — | MT5 login number (matched against MT5 terminal login) |
| `initial_balance` | `numeric` | NULL | — | Starting balance |
| `profit_target_percent` | `numeric` | NULL | — | Total profit target (%) |
| `max_total_drawdown_percent` | `numeric` | NULL | — | Max drawdown (%) |
| `daily_loss_limit_percent` | `numeric` | NULL | — | Daily loss limit (%) |
| `start_date` | `timestamotz` | NULL | — | Evaluation start date |
| `status` | `text` | NULL | `'active'` | Account status |
| `notes` | `text` | NULL | — | Notes |
| `created_at` | `timestamotz` | NOT NULL | `now()` | |
| `updated_at` | `timestamotz` | NOT NULL | `now()` | Auto-updated by trigger |
| `user_id` | `uuid` FK | NULL | — | → `aura_users.id` (cascade) |
| `phase` | `text` | NOT NULL | `'phase1'` | Check: `phase1`/`phase2`/`funded` |
| `prop_firm_id` | `uuid` FK | NULL | — | → `prop_firms.id` |
| `platform` | `text` | NOT NULL | `'MT5'` | Check: `MT5`/`Tradovate`/`Wealthcharts` |
| `drawdown_mode` | `text` | NOT NULL | `'fixed'` | Drawdown rule mode |
| `drawdown_basis` | `text` | NOT NULL | `'balance'` | `balance`/`equity` |
| `drawdown_stop_at_initial_balance` | `boolean` | NOT NULL | `false` | |
| `drawdown_eod_timezone` | `text` | NOT NULL | `'America/New_York'` | EOD timezone |

**Indexes:** `accounts_prop_firm_id_idx` (on `prop_firm_id`)

**Account identification:**
- PK: `id` (UUID)
- MT5 identity: `account_number` (text, MT5 login number)
- Ownership: `user_id` → `aura_users.id`

**Ownership enforcement:** `TradingDataAccess.assertAccountOwnership()` runs:
```sql
SELECT id, user_id, name, platform, phase FROM public.accounts WHERE id = $1 LIMIT 1
```
Throws `AccountAccessError` (HTTP 403) if `user_id` != authenticated user.

#### 2.2 `public.trades` — Table: `04_trades.sql`

**Columns & Types (28 columns):**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` PK | NOT NULL | System-generated |
| `buy_sell` | `text` | NULL | Check: `Buy`/`Sell` |
| `commission` | `numeric` | NULL | |
| `daily_reflection` | `text` | NULL | Default `''` |
| `time_open` | `timestamp without tz` | NULL | MT5 server time |
| `time_close` | `timestamp without tz` | NULL | MT5 server time |
| `instrument` | `text` | NULL | Symbol (e.g., `XAUUSD`) |
| `lots` | `numeric` | NULL | Volume/lot size |
| `pips` | `numeric` | NULL | |
| `pnl` | `numeric` | NULL | Realized P/L (final) |
| `rules_violated` | `text` | NULL | Default `''` |
| `weekly_retrospective` | `text` | NULL | Default `''` |
| `mfe` | `numeric` | NULL | Max Favorable Excursion |
| `price_close` | `numeric` | NULL | Exit price |
| `price_open` | `numeric` | NULL | Entry price |
| `risk_per_trade` | `numeric` | NULL | Risk in dollars |
| `rrr` | `text` | NULL | Reward:risk ratio (e.g., `"2.50R"`) |
| `sl` | `numeric` | NULL | Stop loss |
| `swap` | `numeric` | NULL | |
| `ticket` | `numeric` | NULL | MT5 position ticket |
| `tp` | `numeric` | NULL | Take profit |
| `created_at` | `timestamotz` | NOT NULL | `now()` |
| `updated_at` | `timestamotz` | NOT NULL | Auto via trigger |
| `held` | `text` | NULL | |
| `account_id` | `uuid` FK | NULL | → `accounts.id` |
| `mae` | `numeric` | NULL | Max Adverse Excursion |
| `time_open_ph` | `timestamp without tz` | NULL | Asia/Manila display |
| `time_close_ph` | `timestamp without tz` | NULL | Asia/Manila display |

**Indexes:** `idx_trades_instrument`, `idx_trades_ticket`, `idx_trades_ticket_unique` (PARTIAL UNIQUE WHERE ticket IS NOT NULL), `idx_trades_date_start`, `idx_trades_time_open_ph`, `idx_trades_time_close_ph`

**Open vs. closed:** `time_close IS NULL` → open; `time_close IS NOT NULL` → closed.

**Field coverage:** `buy_sell`, `instrument`, `price_open`, `price_close`, `sl`, `tp`, `lots`, `risk_per_trade`, `rrr`, `time_open`, `time_close`, `ticket`, `commission`, `swap`, `mfe`, `mae` — ALL present. **Floating P/L** is NOT stored (only realized `pnl`).

#### 2.3 `public.user_settings` — Table: `05_user_settings.sql`

**PK:** `user_id` (no `id` column; upsert uses `onConflict: 'user_id'`).

**Key columns:** `default_account_id` (→ `accounts.id`), `default_chart_mode`, `show_account_balance`, `show_pnl`, `show_trading_activity`, `daily_target_percent`.

#### 2.4 `public.trade_screenshots` — Table: `09_trade_screenshots.sql`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `ticket` | `text` | NOT numeric — string MT5 position ID |
| `symbol` | `text` | NULL |
| `storage_path` | `text` | Bucket-relative path |
| `captured_at` | `timestamotz` | Default `now()` |

**Ownership:** No `user_id`. Scoped via: `trades.ticket → account_id → accounts.user_id`.

#### 2.5 Fields NOT in DB (must calculate/fetch from MT5)

**In DB:** `initial_balance`, `profit_target_percent`, `max_total_drawdown_percent`, `daily_loss_limit_percent`

**NOT in DB (must calculate/fetch):** `balance`, `equity`, `floating P/L`, `daily P/L`, `daily loss limit ($)`, `remaining daily allowance`, `max drawdown`, `current drawdown`, `remaining drawdown allowance`, `daily profit target ($)`, `current open risk`, `current open risk %`, `dollar risk`

---

## 3. REAL-TIME MECHANISMS — MT5 BRIDGE

**Source:** `pythonMt5/mt5_api.py` — Flask + Flask-SocketIO (eventlet) on `https://mt5-api.jakemt5.host:5000`.

**Transport:** Socket.IO (WebSocket + long-polling fallback), `cors_allowed_origins="*"`

**Two background daemon threads:**
1. `watch_trades()` — polls every **100ms**: `mt5.positions_get()` + `mt5.orders_get()`
2. `watch_account()` — polls every **5s**: `mt5.account_info()`

### Socket Events

**`account_info`**: `{ login, name, server, balance, starting_balance, info }`

**`price_update`** (every 100ms, every open position): `{ ticket, symbol, volume, type, price_open, price_current, profit, swap, time, sl, tp, sl_value, tp_value, live_rr }` — NOTE: `risk_usd` NOT included; dashboard maps `sl_value` → `riskPerTrade`.

**`trade_opened`**: `{ ticket, symbol, volume, type(0/1), price_open, sl, tp, profit, swap, time_open(UTC), risk_usd, screenshot_url, object }`

**`trade_closed`**: `{ ticket, symbol, volume, type, price_open, price_close, profit, swap, time_close(UTC), reward_risk_ratio, object }`

**`pending_order`/`pending_deleted`** — for pending orders only.

**NOTE:** Bridge NEVER emits `trade_deleted`. Dashboard listens (line 2740) but it's a dead handler.

### MT5 Bridge REST endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | MT5 connection status |
| `/api/history` | GET | Full history JSON |
| `/api/open_trades` | GET | Open positions JSON |
| `/api/account_info` | GET | Current MT5 account info |
| `/api/start-reconnect` | POST | Force MT5 reconnection |
| `/api/place-order` | POST | Place trade |
| `/api/modify-order` | POST | Modify SL/TP |
| `/api/close-trade` | POST | Close trade |

---

## 4. REAL-TIME MECHANISMS — AURA BACKEND SSE

**Source:** `aura-backend/src/realtime/events.js` — Server-Sent Events on `GET /api/events`.

In-process `EventEmitter` (no Redis/Kafka). `data-api.js` calls `publishChange()` on writes. SSE route filters by `session.sub`.

**Event shape:** `{ type:"change", table:"trades", action:"insert|update|delete", userId:"uuid", accountId:"uuid|null", at:"ISO" }`

**Real-time tables:** `trades`, `accounts`, `trade_screenshots`, `behaviors`, `behavior_evidence`, `ai_analyses`, `behavior_alerts`, `certificates`, `payouts`, `roi_transactions`

Dashboard does NOT consume SSE for trades — uses MT5 Socket.IO for live, manual refresh for DB.

---

## 5. AURA CHART V2 BACKEND (NO TRADING ENDPOINTS)

**Source:** `backend/src/index.ts` + `backend/src/routes/*` — Hono framework on `@hono/node-server`.

**Database:** Local Oracle PostgreSQL `aura` DB, localhost:5432. Connection from `/etc/aura/postgres.env`. Pool via `getPgPool()` (localhost-only enforcement).

**Candle table:** `ohlc_candles` — columns: `instrument`, `timeframe`, `bucket_time` (timestamotz), `open`, `high`, `low`, `close`, `tick_count`, `status`, `source`. Unique on `(instrument, timeframe, bucket_time)`.

**Routes:** `/api/health`, `/api/instruments`, `/api/candles/db`, `/api/candles/db/gaps`, `/api/stream/status`, `/api/ema-alerts/*`, `/ws` (WebSocket candles).

**NO trading endpoints** — no `/api/accounts`, `/api/trades`, `/api/positions`, `/api/risk`.

---

## 6. AURA CHART V2 FRONTEND

**Framework:** React (TypeScript) + Vite (dev `localhost:5173`).

**Auth:** NONE. Unauthenticated `fetch()` to `/api/...`. No session, no user identity.

**Realtime:** `useRealtimeStream()` opens WebSocket to `/ws?res=<res>&epic=<epic>`. Receives `status` + `candle` frames (typed in `realtimeCore.ts`).

**NO trade overlay:** No existing component/hook/data structure for trade markers/lines/SL/TP on the chart.

---

## 7. CROSS-SYSTEM DATA FLOW

```
┌──────────────────────────┐  ┌──────────────────────────┐
│ Trading Dashboard        │  │ AURA Chart v2            │
│ PostgreSQL (sep DB)      │  │ PostgreSQL ("aura" DB)   │
│ accounts ← trading accts │  │ ohlc_candles ← market    │
│ trades ← open+history    │  │ NO trading tables        │
│ user_settings ← prefs    │  │                          │
└─────────┬────────────────┘  └─────────┬────────────────┘
          │ POST /api/db/query(5001)    │ WS/fetch(8787)
┌─────────┴────────────────┐  ┌─────────┴────────────────┐
│ AURA Backend (Node)      │  │ AURA Chart Backend(Hono) │
│ localhost:5001           │  │ localhost:8787           │
│ Auth: /api/auth/*        │  │ No auth                  │
│ Data: /api/db/query      │  │ Market data only         │
│ SSE:  /api/events        │  │ WS: /ws (candles)        │
└──────────────────────────┘  └──────────────────────────┘
          │                              │
          │ Socket.IO               fetch() (Vite proxy)
┌─────────┴────────────────┐  ┌─────────┴────────────────┐
│ pythonMt5 Bridge              │ AURA Chart Frontend       │
│ mt5-api.jakemt5.host          │ localhost:5173            │
│ MT5 Terminal (IPC)            │ No auth, no trading UI    │
│ Emits: account_info,          │                           │
│   price_update(100ms),        │                           │
│   trade_opened/closed         │                           │
│ REST: /api/history,           │                           │
│   /api/open_trades            │                           │
└───────────────────────────────┘ ──────────────────────────┘
```

**Constraints:**
1. No cross-database SQL joins — separate PostgreSQL instances
2. AURA Chart has no auth — needs session token to read trading tables
3. MT5 bridge Socket.IO emits to ALL sockets (no rooms)
4. Floating P/L, balance, equity — ONLY on MT5 bridge stream, never persisted
5. Live trades ARE persisted to Trading Dashboard DB via `persistLiveTrade()`

---

## 8. FIELD-BY-FIELD COVERAGE

### LIVE OPEN TRADES (all from MT5 Socket.IO)

| Field | Source | Available? |
|---|---|---|
| BUY/SELL | `trade_opened.type`/`price_update.type` (0=Buy/1=Sell) | YES |
| symbol | `trade_opened.symbol`/`price_update.symbol` | YES |
| entry price | `trade_opened.price_open`/`price_update.price_open` | YES |
| current price | `price_update.price_current` | YES |
| stop loss | `trade_opened.sl`/`price_update.sl` | YES |
| take profit | `trade_opened.tp`/`price_update.tp` | YES |
| volume | `trade_opened.volume`/`price_update.volume` | YES |
| floating P/L | `price_update.profit` | YES |
| risk in dollars | `trade_opened.risk_usd`; `price_update.sl_value` (mapped) | YES |
| risk in percentage | `risk_usd / initial_balance * 100` (calc) | YES (calc) |
| R multiple | `price_update.live_rr` | YES |
| open time | `trade_opened.time_open` (UTC string) | YES |
| trade ticket | `trade_opened.ticket`/`price_update.ticket`/`trade_closed.ticket` | YES |

### ACCOUNT RISK / LIMIT

**In DB (`accounts` table):** `initial_balance`, `profit_target_percent`, `max_total_drawdown_percent`, `daily_loss_limit_percent`

**NOT in DB (must calculate/fetch):**

| Field | In DB? | Must calculate/fetch from |
|---|---|---|
| balance | NO | MT5 `account_info.balance` (live only) |
| equity | NO | `balance + SUM(open trade floating P/L)` |
| floating P/L | NO | Sum `profit` from MT5 `price_update` |
| daily P/L | NO | Sum `pnl` from `trades` (closed today) + open floating |
| daily loss limit ($) | NO (only %) | `initial_balance * daily_loss_limit_percent / 100` |
| remaining daily allowance | NO | `daily_limit_$ - max(0, abs(daily_loss))` |
| max drawdown | NO | Requires equity curve (not stored) |
| current drawdown | NO | `peak_equity - current_equity` |
| remaining drawdown allowance | NO | `max_dd_$ - current_drawdown` |
| daily profit target ($) | NO (only %) | `initial_balance * profit_target_percent / 100` |
| total profit target ($) | NO (only %) | Same |
| current open risk | NO | `SUM(risk_per_trade)` from open trades |
| current open risk % | NO | `total_open_risk / initial_balance * 100` |
| dollar risk | NO (only %) | `initial_balance * daily_loss_limit_percent / 100` |

### HISTORICAL TRADES (all from `trades` table)

| Field | DB Column | Available? |
|---|---|---|
| entry marker | Plot at `time_open` | YES |
| exit marker | Plot at `time_close` | YES |
| entry price | `price_open` | YES |
| exit price | `price_close` | YES |
| BUY/SELL | `buy_sell` | YES |
| open time | `time_open`/`time_open_ph` | YES |
| close time | `time_close`/`time_close_ph` | YES |
| P/L | `pnl` | YES |
| volume | `lots` | YES |
| R multiple | `rrr` | YES |
| SL/TP | `sl`/`tp` | YES |
| MFE/MAE | `mfe`/`mae` | YES |
| ticket | `ticket` | YES |
| symbol | `instrument` | YES |
| screenshot | `trade_screenshots` table | YES (via join) |

---

## 9. KEY FINDINGS & CONSTRAINTS

1. **Real-time infrastructure already exists** — MT5 Socket.IO stream + AURA Backend SSE bus. Do NOT introduce new polling/WebSocket/SSE infrastructure.
2. **No cross-database SQL joins** — AURA Chart DB (`aura`, Oracle PostgreSQL) ≠ Trading Dashboard DB (separate PostgreSQL). Data must cross via HTTP API only.
3. **AURA Chart has NO authentication** — frontend makes unauthenticated requests. Must add session/auth to read trading tables from AURA Backend (`/api/db/query`).
4. **`trade_deleted` is dead code** — MT5 bridge never emits it; only `trade_closed` fires.
5. **`price_update` lacks `risk_usd`** — dashboard derives it from `price_update.sl_value`.
6. **SL/TP updates NOT propagated** — `updateMT5TradePrice()` doesn't update `sL`/`tP` fields; only `profit`, `swap`, `netProfit`, `mfe`, `mae`.
7. **Live trades ARE persisted** — dashboard calls `persistLiveTrade()` on every `trade_opened`/`trade_closed`/`price_update`. DB stays in sync. AURA Chart can read from `/api/db/query` (historical + open) and optionally connect to MT5 Socket.IO for live tick updates.
8. **Floating P/L, balance, equity are ephemeral** — only on MT5 terminal/bridge stream, never persisted to DB. Historical equity curve cannot be reconstructed from stored data alone.
9. **Symbol mapping required** — MT5 uses `XAUUSD`; AURA Chart uses `CS.D.CFIGOLD.CFI.IP`. No existing symbol mapping. Need a mapping table.
10. **AURA Chart candles are CAPITAL-based** — MT5 uses its own symbol naming. No existing symbol normalization between the two systems.
