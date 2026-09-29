# LIVE OPEN-TRADE + ACCOUNT RISK OVERLAY — READ-ONLY AUDIT (PHASE 1)

Status: **AUDIT ONLY — NO APPLICATION CODE WAS CHANGED.**
Scope read: `MyTradingDashboard2/aura-backend`, `MyTradingDashboard2/trading-dashboard`
(`DrawdownService` = the logic authority), `MyTradingDashboard2/pythonMt5`,
`MyTradingDashboard2/db/schema`, `AURA-Chart-v2/backend`, `AURA-Chart-v2/frontend`.

---

## 1. Existing account-state architecture

**Path (must be preserved):**
`MT5 terminal → pythonMt5 (local bridge) → Dashboard PostgreSQL → aura-backend → AURA Chart backend (proxy) → AURA Chart frontend`

- **Authoritative account config** is `public.accounts` (`db/schema/03_accounts.sql`). Every field this
  feature needs already exists — **no new columns**: `initial_balance`, `profit_target_percent`,
  `max_total_drawdown_percent`, `daily_loss_limit_percent`, `drawdown_mode`
  (`fixed|intraday_trailing|balance_trailing|eod_trailing`), `drawdown_basis` (`balance|equity`),
  `drawdown_stop_at_initial_balance`, `drawdown_eod_timezone`, `start_date`, `phase`, `status`,
  `account_number`.
- **Read surface:** `aura-backend/src/db/trading-overlay.js` →
  `GET /api/trading/accounts/:accountId/state` (`getAccountState`, lines 256–297). It returns that
  static config plus DB-derived `openPositions` / `openLots` (`count(*)` and `sum(lots)` where
  `time_close is null`).
- **The gap:** every live-money field is hard-coded `null` (lines 285–295) — `balance`, `equity`,
  `floatingPnl`, `dailyPnl`, `dailyLossLimit`, `maxDrawdown`, `currentDrawdown`, `drawdownRemaining`,
  `openRisk`. The module header (lines 43–45) states this is deliberate: live state is not persisted
  and the MT5 subscriber is "a later phase". **This is the single biggest gap.**
- **Proxy already in place:** `AURA-Chart-v2/backend/src/routes/trading.ts`
  (`/trading/accounts/:id/state`) → `DashboardClient.getAccountState()` →
  `tradingApi.getTradingAccountState()`. The frontend `AccountState` type already declares those
  fields as `null`, so populating them is purely additive on the type side.
- **MT5 identity is already read through the bridge:**
  `AURA-Chart-v2/backend/src/services/mt5Account.ts` → `GET /api/account_info`, returning only
  `{connected, login, server, name, reason}` through a never-throw, display-safe reader. This is the
  established precedent for a bounded server-side MT5 read.

## 2. Existing open-trade architecture

- **The open definition is already authoritative:** `time_close IS NULL`
  (`trading-overlay.js` lines 31–34, `buildTradesSql` `status === 'open'`, `withDerivedStatus`).
  `trades` has **no** `status` column — it is always derived.
- **AURA Chart already loads and renders open trades:** `App.tsx` calls
  `getTradingTrades(accountId, { status: "all", limit: 2000 })`; `tradeOverlay.ts` builds the
  overlays; `TradeOverlayBridge` / `TradeOverlayPrimitive` render them, including the existing
  live/open forming-bucket extension and the "open is never classified as won/lost" band semantics.
- **Gap:** a `public.trades` row for an open position has **no** `price_current`, and its `pnl` is not
  a reliable live float. Live P&L must come from MT5, not from the DB row.

## 3. Existing realtime/event architecture

- **Dashboard bus:** `aura-backend/src/realtime/events.js` — an in-process `EventEmitter`,
  advisory-only, event `{type:'change', table, action, userId, accountId, at}`. `REALTIME_TABLES`
  already contains **both `trades` and `accounts`**. Published from `db/data-api.js` lines 255–263
  after every successful write.
- **Transport to AURA Chart:** SSE `GET /api/events` on aura-backend. The AURA Chart backend already
  subscribes once per validated session in `backend/src/services/tradeEventRelay.ts`, validates the
  token through the existing `DashboardClient.getSession`, and fans advisory frames **only to that
  user's** `/ws` clients. Coalesced per `(userId, accountId)` at `TRADE_REFRESH_DEBOUNCE_MS = 500`.
- **Pattern to reuse verbatim:** event → **refetch authoritative state** → render. Event payloads are
  never treated as state. **No new pipeline and no polling are required.**
- **Note:** the relay currently filters `table === 'trades'` only. `accounts` is already allowed by the
  upstream bus, so account-config changes can reuse the same relay (a one-line widening, not a second stream).

## 4. Existing account risk fields (all already in the DB)

| Need | Authoritative source | Notes |
|---|---|---|
| Initial balance | `accounts.initial_balance` | already in `AccountState.initialBalance` |
| Profit target | `accounts.profit_target_percent` | a **percent of initial balance**, not dollars |
| Daily loss limit | `accounts.daily_loss_limit_percent` | a **percent of initial balance** |
| Max drawdown | `accounts.max_total_drawdown_percent` + `drawdown_mode` / `drawdown_basis` / `drawdown_stop_at_initial_balance` / `drawdown_eod_timezone` | the **configured ceiling**; current drawdown is a separate derived value |
| Balance / equity / floating P&L | MT5 `account_info()` | **not persisted in the DB at all** |

**Semantics that must not be conflated:**
- `daily_loss_limit_percent` and `profit_target_percent` are account-level percent-of-initial-balance limits.
- `max_total_drawdown_percent` is the configured **maximum allowed** drawdown; the **current** drawdown
  is derived, never stored.
- Because `drawdown_mode` can be trailing/EOD, the drawdown floor **moves** — it is not always
  `initial_balance × percent`. Computing it naively would be incorrect.
## 5. Existing P&L calculations

- **Realized P&L:** `trades.pnl` (written by MT5 on close). `aura-backend/src/proactive.js`
  `calculateDailyPnl` (line 235) = `sum(Number(t.pnl) || 0)` over "today's trades" from
  `getTodayTrades` — **local-midnight** `time_open >= todayStart`, capped at 100 rows, across **all** of
  the user's accounts. ⚠️ It is an alert heuristic, not a per-account authoritative daily figure.
- **Floating P&L:** per-position `pos.profit` (+ `pos.swap`) straight from MT5.
- **R:R / risk:** pythonMt5 already computes `risk_1R = abs(order_calc_profit(..., sl))` and
  `current_R = round(pos.profit / risk_1R, 2)`, plus `sl_value` / `tp_value` via `mt5.order_calc_profit`
  (lines 326–366), and `risk_usd` from ticks × tick value.

## 6. Existing drawdown calculation (the one to reuse)

**`trading-dashboard/src/app/services/drawdown.service.ts` is the authoritative engine** and is
documented as the single implementation (the dashboard UI never implements drawdown math itself):
- `getMaxDrawdownAmount(startingBalance, maxDrawdownPercent) = startingBalance × pct/100` (line 138)
- `computeState(config, input)` → `DrawdownState` (line 147) with `{ floor, maxDrawdownAmount,
  bufferUsedPercent, breached, approaching, status, locked }`, covering all four modes and the
  `balance|equity` basis, degrading safely on partial data.

⚠️ **It lives in the Angular Dashboard app, not in `aura-backend`, and it is an injectable TypeScript
class. `aura-backend` has no equivalent.** `proactive.js` `calculateMaxDrawdown` (line 248) is a
different, weaker running-realized-P&L peak-to-trough and is **not** the configured-limit semantics.
So "reuse existing business logic" requires porting `computeState` into `aura-backend` as the shared
authority; duplicating it in the AURA Chart frontend is explicitly out of bounds.

## 7. Existing daily-loss calculation

None authoritative. Only `proactive.js` alert thresholds (which compare a **percent** against
`daily_loss_limit_percent`, itself a percent — see its own bug at lines 63–73) and
`05_user_settings.sql` `daily_target_percent`, which lives on **user settings** and is a different
concept from the account's `daily_loss_limit_percent`. **There is no account daily-loss state
calculation in `aura-backend` today.**

## 8. Existing profit-target calculation

None beyond the stored `profit_target_percent`. The target **amount** is a trivial authoritative
derivation in the same form as `getMaxDrawdownAmount`: `initial_balance × profit_target_percent / 100`.

## 9. Instrument price ↔ P&L conversion capability

- **The sound primitive already exists:** MT5's
  `order_calc_profit(type, symbol, volume, entry, exitPrice)` → money, already used by pythonMt5 for
  `sl_value` / `tp_value`. Its **inverse** (solve for the exit price that reaches a target money
  amount) is the only mathematically defensible conversion.
- **Practical inverse, for the chart instrument only:** per-position money-per-price-point sensitivity
  `tick_value / point × volume` (exactly how `risk_usd` is computed), then
  `price = entryPrice ± (targetMoney / sensitivity)`, signed per side and aggregated across that
  instrument's positions only.
- **Multi-instrument or no-position case:** sensitivity is undefined, so a price level is **not
  derivable and must not be faked** — show the monetary annotation only.

## 9.5 STRICT READ-ONLY GUARANTEE (non-negotiable, proven by tests)

**The data flow is one-way and terminates at AURA Chart:**

```
MT5  →  Dashboard / MT5 bridge  →  AURA Chart  →  VISUALIZATION ONLY
                                        ✗ never  →  any MT5/broker command
```

**No trading action may exist anywhere in this feature.** The implementation will contain **no**
close / partial-close / modify / modify-SL / modify-TP / move-SL / move-TP / cancel-pending /
place-order / modify-pending / change-lot / change-position capability, and **no broker- or
MT5-command endpoint of any kind**. AURA Chart's backend will issue only bounded **GET** requests
to the existing bridge read endpoints; it never calls an `order_send`-style path, and pythonMt5
itself will not be modified.

**Rendering must be non-interactive.** `TradeOverlayPrimitive` and the new risk-level drawing will
contain no drag handlers, no mouse/touch editing, no price modification, no order callbacks, and no
mutable trade state exposed through UI interaction. Live markers and the three account-risk levels
are informational pixels only — the user cannot drag, move, resize, or edit any of them. The
overlay visualizes actual MT5 state; it is **not** a drawing tool and **not** an order-management
interface. Hover/tooltip is permissible; a click may reveal information, but **no action menu that
can modify a trade** may exist. Levels and labels are positioned solely from authoritative
MT5/Dashboard values.

**Proof obligations (added to the test plan):**
- A static-source assertion that the changed files contain no order/trade-action route, no HTTP
  verb other than `GET` toward MT5, and no `order_*` / `order_send` symbol.
- A primitive test that renders the live overlay against a recording context and asserts **zero**
  pointer/touch/drag event subscriptions and zero mutation callbacks.
- A regression assertion that the primitive's public surface gained no interactive handles.

## 10. Exact files that need modification

**AURA-Chart-v2/backend (additive proxy/service layer)**
1. `backend/src/services/mt5Account.ts` — extend with a bounded, typed, never-throw read of the
   existing bridge endpoints `/api/account_info` (balance/equity) and `/api/open_trades` (live
   positions: `profit`, `price_open`, `sl`, `tp`, `volume`, `symbol`, `type`, `swap`). Same
   display-safe pattern already used for identity; the raw `object` field is never forwarded.
2. `backend/src/services/tradeEventRelay.ts` — widen the accepted `table` from `trades` to include
   `accounts`, so account-config edits reuse the same relay and debounce (no new stream).
3. `backend/src/services/dashboardClient.ts` / `backend/src/routes/trading.ts` — additive typing for
   the richer state payload; **no new route**, no path change, same auth/ownership.

**AURA-Chart-v2/frontend (rendering only)**
4. `frontend/src/services/tradingApi.ts` — widen the live `AccountState` fields from `null` to real shapes.
5. `frontend/src/services/tradeOverlay.ts` — **additive only**: pure builders for live open-trade and
   account-risk descriptors (aggregation, sensitivity math, "no derivable level" flags). All existing
   historical builders untouched.
6. `frontend/src/components/TradingChart/TradeOverlayPrimitive.ts` — **additive only**: draw live
   position markers and account-risk horizontal levels, reusing existing tokens, line style, measured
   invert-scale handling and label de-collision. Closed-trade branches untouched.
7. `frontend/src/components/TradingChart/TradeOverlayBridge.tsx` — pass the new props through.
8. `frontend/src/components/TradingChart/TradingChart.tsx` — supply the live last price used for
   sensitivity and label anchoring.
9. `frontend/src/App.tsx` — fetch account state on selection and refetch on the existing coalesced
   event; pass it to the bridge.
10. `frontend/src/styles.css` — only if a genuinely new compact label class is needed.

**MyTradingDashboard2/aura-backend (the missing authoritative math — see §16)**
11. `aura-backend/src/db/trading-overlay.js` — `getAccountState` stops returning hard-coded `null` for
    the live/risk fields and instead returns values from the shared module below. Read-only, fixed SQL,
    unchanged whitelist and security model.
12. **New** shared pure module — a faithful Node port of `DrawdownService.computeState` +
    `getMaxDrawdownAmount`, becoming the single drawdown authority for both consumers.
13. **New** live-state module — bounded read of MT5 live money via the existing bridge REST pattern,
    plus the selected account's today's realized P&L, floating P&L, open positions and derived risk levels.

**Tests**
14. `frontend/tests/` — new focused suites (§15). `backend/src/tests/` — suites for the ported drawdown
    engine and the live-state reader.

## 11. Exact files that should NOT be modified
- `db/schema/*.sql` — **no new columns**; every required field already exists.
- `aura-backend/src/db/trading-overlay.js` **security model** — no new tables, no caller-supplied
  identifiers, no generic query surface.
- `MyTradingDashboard2/trading-dashboard/src/app/services/drawdown.service.ts` — it stays the reference
  implementation; AURA Chart does not edit the Dashboard.
- Historical rendering path: `TradeOverlayPrimitive.ts` **closed-trade** branches, `resolveExactTimeX`,
  `markerApex`, `bandOutcome`, `tradeOverlay.ts` historical builders, and the `tradeOverlayExactX` /
  `tradeOverlayVisual` tests.
- `frontend/src/services/auth.ts`, `accountSelection.ts`, `mt5Time.ts` — no auth, account-selection or
  MT5-timestamp changes.
- `pythonMt5` — **no changes**; AURA Chart consumes the existing REST endpoints over HTTP and never
  touches MT5 Socket.IO.
- No PostgreSQL connection and no MT5 Socket.IO client anywhere in AURA Chart.
- **Any write path, in either repo:** no trade-action route, no MT5 `order_*` call, no order/position
  mutation, and no UI affordance that could send one. The live overlay is read-only end to end (§9.5).


## 12. Proposed data flow (event → refetch → render)

```
MT5 terminal
  └─ pythonMt5 (existing bridge, unchanged)
       ├─ GET /api/account_info   ─┐  (bounded, server-side, existing endpoints)
       └─ GET /api/open_trades   ─┘
              │
              ▼
aura-backend  ── computes (shared module, read-only): live balance/equity/floating,
              │   today's realized P&L, open positions, drawdown state, risk levels
              ├─ GET /api/trading/accounts/:id/state   (existing route, richer payload)
              └─ publishChange('accounts'|'trades')  → SSE /api/events (existing)
              │
              ▼
AURA-Chart backend (proxy, unchanged transport; mt5Account-style reader)
              │  /ws frame (advisory only) — existing 500 ms coalesced relay
              ▼
AURA Chart frontend: event → refetch account state + trades (existing pattern)
                     → pure builders → TradeOverlayBridge → TradeOverlayPrimitive
                     → DISPLAY ONLY (no handlers, no actions, no outbound writes)
```

Live **price** for P&L labels comes from the chart's own candle/quote stream — **no new price transport**.

Every arrow above is a **read**. There is no arrow from AURA Chart back to MT5 — by design (§9.5).

## 13. Proposed rendering flow
1. A pure builder in `tradeOverlay.ts` takes `{ accountState, openTrades, chartInstrument, currentPrice }`
   and returns descriptors: one per open position on the chart instrument, plus account-risk level descriptors.
2. **Open trade on the chart instrument:** the existing entry-triangle style at `entryPrice`, a live
   P&L label (`BUY 0.33 +$58.08`, `R`, price), and SL/TP levels in the existing stop/target styles.
   Positions on other instruments are **not** projected onto this price axis.
3. **Aggregation (Part 5):** multiple positions on the same instrument are aggregated with correct sign
   handling and per-unit sensitivity; sensitivity is per-instrument and **only** for instruments with positions.
4. **Account-risk levels:** horizontal lines with compact right-edge labels
   (`PROFIT TARGET +$500`, `DAILY LOSS LIMIT -$300`, `MAX DRAWDOWN -$1,000`). A price level is attached
   **only when mathematically derivable**; otherwise the monetary threshold is shown as an account-risk
   annotation with **no** misleading price.
5. **Invert scale:** levels follow the same measured coordinate behavior as the existing markers; the
   numerical anchor is unchanged.
6. **Label collision:** offset labels vertically/horizontally while the **line stays exactly on its price**.

## 14. Edge cases
- No open trades / no positions on the chart instrument → no price levels; monetary annotations only.
- Multiple positions, mixed BUY/SELL, same instrument → net sensitivity; a mixed book may have near-zero
  or non-monotonic sensitivity, in which case no price level is drawn (only the annotation).
- Position with no SL → no risk / R:R; R:R is shown only when it can be computed reliably.
- `initial_balance` null or a limit percent null/0 → that level is omitted, never defaulted to 0.
- Drawdown modes `intraday_trailing` / `balance_trailing` / `eod_trailing` → the floor moves; the
  overlay must show the **configured** ceiling and the **derived** current state distinctly.
- `drawdown_basis = equity` with equity unavailable → degrade to balance basis, flagged, never invented.
- Account mismatch (selected account ≠ MT5 login) → keep the existing warning; overlays stay bound to
  the **selected** account and must not mix state.
- Daily boundary / timezone (`drawdown_eod_timezone` ≠ the browser's local day) → daily P&L must use
  the Dashboard's day semantics, not the browser's.
- Replay mode → live overlays hidden exactly as historical overlays are.
- Label collision when levels are within a few pixels → de-collide the labels, never the lines.

## 15. Validation / test plan
- **Backend (chart repo):** bridge live-state reader (degradation on timeout/unreachable/malformed, never
  throws); relay widening for `accounts`; proxy state passthrough typing.
- **Backend (aura-backend):** ported drawdown engine vs. the Dashboard's `computeState` across all four
  modes and both bases; live-state aggregation; no new SQL identifiers.
- **Frontend pure logic:** per-position sensitivity; multi-position BUY/SELL aggregation; mixed-book
  refusal; profit-target amount derivation; daily-loss remaining-budget math; drawdown ceiling vs.
  current-state separation; "no derivable level" flags.
- **Frontend rendering:** live marker, SL/TP styles, three account-risk levels, compact labels, invert
  scale, de-collision, and a regression suite proving the **historical** overlay is unchanged.
- **Integration:** event → refetch (500 ms coalescing), account switching clears old state, MT5
  mismatch warning preserved, replay hiding.
- **Runtime:** real browser, real MT5 account, both scales, 1m/3m, with a win/loss and a multi-position account.

### READ-ONLY ENFORCEMENT TESTS (required, from §9.5)
- **No trade-action surface:** source scan of every file this feature touches asserts zero matches
  for order/trade-action routes and MT5 command symbols (`order_send`, `order_check`, `orders_get`,
  `positions_get` writes, close/modify/cancel verbs), and asserts the MT5-facing client performs
  `GET` only.
- **No interaction handlers:** the live overlay primitive test registers recording stubs for
  `pointer*` / `mouse*` / `touch*` / `drag*` and asserts **zero** subscriptions, and asserts the
  primitive exposes no interactive handle/callback property.
- **One-way flow:** the backend test suite asserts every new backend function is a read (`GET` to the
  bridge) and that the frontend issues no mutating request for any live-overlay interaction.
- **No regression of the read-only posture:** a full-suite run must show the existing suites
  (`tradeOverlayExactX`, `tradeOverlayVisual`, overlay feed, live overlay, account selection) still passing.

## 16. Open decisions — required before implementation

**D1 — Scope: the authoritative math does not currently exist in a shared place.**
`getAccountState` returns hard-coded `null` for every live/risk field, and the only correct
drawdown implementation lives in the Dashboard's **Angular** service. To honour "reuse existing
business logic instead of duplicating it in the frontend", the drawdown engine must become a
Node module inside `aura-backend` and the live state must be read there.
→ **Recommendation: allow additive changes in `MyTradingDashboard2/aura-backend`** (new modules +
`getAccountState` enrichment; no schema, no new routes, no security-model change).
→ *Alternative if you want the chart repo only:* compute in the AURA Chart backend instead, but
that necessarily **duplicates** the Dashboard's drawdown logic and risks the two drifting apart.
Please confirm D1.

**D2 — One-time port vs. shared import.** `drawdown.service.ts` is an Angular-injectable
TypeScript class; `aura-backend` is plain Node ESM and cannot import it. The plan is a
line-for-line **port** of `getMaxDrawdownAmount` + `computeState`, verified by a test that runs
identical fixtures through both implementations. The Angular file stays the reference and is
**not** edited. Approve the port?

**D3 — Price levels are drawn only when derivable.** A dollar threshold becomes a price only via
that instrument's real sensitivity (`tick_value / point × volume`, the same basis pythonMt5 uses
for `risk_usd`). With no position on the chart instrument — or a mixed BUY/SELL book whose net
sensitivity collapses — the line is **omitted** and only the monetary annotation is shown.
This is the "do not display misleading price levels" rule. Approve?

**D4 — Daily-loss day boundary.** `proactive.js` sums today's `pnl` using **local midnight** and
across **all** of a user's accounts — an alert heuristic, not a per-account authoritative figure.
The overlay needs per-account realized P&L for the Dashboard's trading day. The plan computes it
**server-side in `aura-backend`**, scoped to the selected account, and documents the day boundary
it uses rather than copying the browser's local day. Confirm the boundary you want (account
`drawdown_eod_timezone` is the natural candidate).

**D5 — Open-trade P&L source.** Live `profit` cannot come from the `trades` row (it has no
`price_current`, and a NULL `pnl` on an open row is not a live float). It comes from the bridge's
existing `GET /api/open_trades` (`profit`, `swap`, `sl`, `tp`, `volume`, `price_open`, `type`).
The authoritative `time_close IS NULL` **open/closed definition stays exactly as it is** — the
live position read supplies the *values*, not the status. Approve?

---

**Stopping here for your approval, as instructed. No application code was modified in Phase 1**
(`git status` shows only this new untracked document alongside pre-existing scratch files).
Once D1–D5 are answered I will begin implementation.

