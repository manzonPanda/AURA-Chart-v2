# P3-D — ACCOUNT SELECTION + MT5 ACCOUNT MATCHING + HISTORICAL TRADE OVERLAY AUDIT

**Type:** READ-ONLY audit. No application source, tests, config, or schema was modified.
**Method:** static code inspection + a temporary runtime trace (removed) through the REAL P2 chain (AURA :8787 → aura-backend :5001 → PostgreSQL) using the P2-verified HMAC session-mint mechanism, plus a stage-count replay running the REAL production `tradeOverlay.ts` functions against the REAL fetched trades.

---

## 1. Executive summary

The historical MT5 trade pipeline is **functionally intact end-to-end** and was proven with real data:

- The P2 chain returns **2 036 real historical trades** across ~35 accounts (HTTP 200, live DB).
- `buildTradeOverlays()` (real production code, real rows) builds **1 068 overlays**; **49 map to GOLD (XAUUSD)** and would pass the chart's `overlaysForEpic` filter on the GOLD chart.
- Symbol mapping is correct for XAUUSD→GOLD; **DAX40 (161 trades), NAS100 (14), US100 (5)** are correctly left unresolved (no invented mappings).
- Timestamp conversion is correct (Europe/Helsinki per-timestamp DST; verified below with a real trade).

**The reported "no markers visible" symptom was NOT reproduced by code-path analysis.** Every static stage produces non-zero counts for GOLD. The residual suspects, in order of likelihood:

1. **ACCOUNT SELECTION problem (confirmed architectural gap):** App.tsx fetches trades for **ALL** accounts in a sequential loop and merges them. One failed account request aborts the whole loop and **clears every overlay** (`catch → setTradeOverlays([])`). With ~35 sequential requests per sign-in, a single transient failure silently blanks the layer. There is no account selector at all.
2. **RENDERING problem (unverifiable statically):** P3-B/P3-C verification was headless (unit + runtime API tests); no browser/DOM verification of `TradeOverlayPrimitive` painting exists. The chart-range analysis below shows recent GOLD trades **should** be inside the default 2-week horizon.
3. **ACCOUNT MISMATCH problem (missing feature):** AURA has no knowledge of which MT5 account the terminal is logged into; the selected-vs-connected comparison cannot occur today.


**Classification: ACCOUNT SELECTION problem (primary, confirmed) + ACCOUNT MISMATCH problem (missing capability) + RENDERING problem (unverified in browser; not reproducible statically). NO DATA/API, SYMBOL, or TIMESTAMP bug was found.**

## 2. Current account architecture

| Piece | File(s) | Behavior |
|---|---|---|
| AURA session/auth | `frontend/src/services/auth.ts`, `backend/src/routes/auth.ts`, `backend/src/services/dashboardClient.ts` | HMAC token → `DashboardClient.getSession(token)` validates against aura-backend `/api/auth/session`. No Supabase. |
| Accounts list | `frontend/src/services/tradingApi.ts` → `getTradingAccounts()` → AURA `GET /api/trading/accounts` → aura-backend | Ownership-scoped (`public.accounts WHERE user_id`). Real trace: **35+ accounts** (prop-firm + demo accounts), all `platform: "MT5"`. |
| Account identity columns | `MyTradingDashboard2/db/schema/03_accounts.sql` | `account_number text null` — **null for the first 5 accounts, populated for the rest** (verified: lengths 6–8, one APEX row stores non-numeric text). Not a reliable MT5-login key today. |
| Trades API | `GET /api/trading/accounts/:id/trades` | Strictly account-scoped server-side (`WHERE account_id = $1`, ownership-verified; foreign id → 403). |

## 3. Existing account selector behavior (AURA Chart)

**There is none.** `frontend/src/App.tsx` (~line 336–364, P3-B data feed):

```ts
const accounts = await getTradingAccounts();
for (const account of accounts) {
  const res = await getTradingTrades(account.id, { status: "all", limit: 2000 });
  records.push(...res.trades);
}
setTradeOverlays(buildTradeOverlays(records, 60));
```

- Every account's trades are **merged into one overlay set** — trades from Account A and Account B are indistinguishable on the chart.
- No `selectedAccountId` state exists anywhere in App.tsx.
- Any thrown error inside the loop jumps to `catch` → **all overlays cleared** (silent blank layer).

## 4. Existing Trading Dashboard account behavior (the reusable pattern)

`MyTradingDashboard2/trading-dashboard`:

- **Selection:** `AccountContextService` — single source of truth; selection persisted to `user_settings.default_account_id`; stale saved id falls back to the first account. The dashboard restores its own `selectedAccount` from the same column.
- **MT5 identity:** `mt5AccountLogin` from the pythonMt5 socket `account_info` event → `normalizeAccountNumber(data?.login)` (trim-to-string, no fabrication); cleared to `null` on disconnect.
- **Mismatch:** a **computed getter** (never stale):
  `mt5AccountMismatch = mt5ServiceConnected && mt5AccountLogin !== null && !isActiveMt5Account()`
  Rendered as a `role="alert"` banner: *"MT5 is connected to account X, but you are viewing Y. Live MT5 trades are hidden so data from the wrong account is never mixed into this dashboard."*
- **Safety behavior:** on mismatch the dashboard **drops live MT5 trades** (`mt5LiveTrades = []`) and gates all live-trade effects with `if (!this.isActiveMt5Account()) return;` — historical data stays tied to the selected account; nothing is merged or auto-switched.

**This is exactly the pattern to reuse conceptually in AURA (getter + banner + hide-live-on-mismatch), not a second architecture.**

## 5. Current MT5 account identity source

`MyTradingDashboard2/pythonMt5/mt5_api.py` → `build_account_payload(info)` (used by the account watcher, `on_connect`, `reconnect_mt5`, and the `/api/account_info` REST endpoint):

```python
{ 'login': info.login, 'name': info.name, 'server': info.server,
  'balance': info.balance, 'starting_balance': info.balance, 'info': info._asdict() }
```

- pythonMt5 already identifies the connected MT5 account (login + server + name) and pushes it via the existing Socket.IO feed to the dashboard; a REST endpoint also exists.
- **AURA Chart currently consumes none of this** — no AURA code reads account_info. No new identity mechanism is needed; the data already exists one hop away.

## 7. Real historical trade retrieval result (measured)

- **Accounts returned:** 35+ (UUID ids; names redacted of identifiers).
- **`account_number`:** null on the first 5 accounts; present on the rest (6–8 digit tails; one non-numeric APEX-style string).
- **Total real trades fetched (`status=all&limit=2000`): 2 036** across all accounts. Several accounts returned 0; several hit the 2 000 cap.
- Representative real trades (tickets as stored):

| instrument | buy_sell | lots | price_open | price_close | sl | tp | time_open (DB) | time_close (DB) | pnl | status |
|---|---|---|---|---|---|---|---|---|---|---|
| XAUUSD | Sell | 0.11 | 4325.51 | 4313.22 | 4329.75 | 4311.58 | 2026-09-22 05:56:08 | 2026-09-22 06:09:25 | 134.42 | closed |
| XAUUSD | Buy | 0.17 | 4470.63 | 4486.81 | 4470.91 | 4488.30 | 2026-09-04 02:28:37 | 2026-09-04 02:45:58 | 273.87 | closed |
| DAX40 | Buy | 0.91 | 26264.07 | 26269.26 | 26251.07 | 26269.79 | 2026-08-04 12:04:00 | 2026-08-04 12:08:00 | 5.44 | closed |

All overlay fields (direction, entry/exit price, SL, TP, lots, pnl, open/close times) are present in the P1 whitelist response, plus `rrr`, `mfe`, `mae`, `risk_per_trade`.

## 8. Historical trade filtering counts (measured, real data through real production code)

| Stage | Count | Note |
|---|---|---|
| API trades (all accounts) | **2 036** | live P2 chain |
| `buildTradeOverlays()` output | **1 068** | drops: unparsable/missing entry time, missing entry price, plus ~12 rows with empty instrument string |
| Symbol histogram | EURUSD 98 · GBPUSD 625 · (empty) 12 · NZDUSD 87 · NAS100 14 · **DAX40 161** · **XAUUSD 49** · USDCHF 17 · US100 5 | |
| `resolved === true` | **49** | XAUUSD only — the map has exactly one entry, by design |
| `overlaysForEpic(…, "GOLD")` | **49** | would pass the TradingChart filter |
| `overlaysForEpic(…, "DAX")` | **0** | DAX40 unresolved by design (correct) |
| TradingChart `visibleTradeOverlays` | 49 on GOLD chart | filter `o.resolved && o.epic === instrumentEpic` — epic values match ("GOLD" = "GOLD"; backend registry epic is literally `GOLD`) |
| TradeOverlayBridge → Primitive | same array; attached per chart controller; cleared only when `enabled === false` (replay) or empty | code verified |

**The count never reaches zero on the GOLD path.** The disappearance (if real in the browser) happens at the rendering/visibility layer or via the App.tsx all-accounts loop's all-or-nothing error handling — not in data, mapping, or timestamps.

## 9. Real symbol examples

Actual MT5 symbols in the historical DB: `XAUUSD`, `DAX40`, `NAS100`, `US100`, `EURUSD`, `GBPUSD`, `NZDUSD`, `USDCHF`, plus 12 rows with an **empty-string instrument** (a real data-quality defect to flag upstream, not to map around).

- `XAUUSD` → GOLD ✅ (verified mapping; 49 real trades resolvable).
- `DAX40` → **unresolved**. The DAX trades use the literal symbol `DAX40`, **not** `DE40` as previously assumed. Per instructions the mapping was NOT added; note that the P3-A candidate name (`DE40`) does not match the observed live symbol (`DAX40`) — any future mapping decision must use this corrected evidence.
- `NAS100` / `US100` → no AURA instrument (registry is DAX + GOLD only); correctly unresolved.

## 10. Real timestamp conversion example (Europe/Helsinki logic, real trade)

XAUUSD trade from September (EEST, UTC+3):

```
raw DB (MT5 server wall clock) : 2026-09-22 05:56:08
Europe/Helsinki interpretation : EEST = UTC+3  (per-timestamp Intl, NOT fixed +3)
true UTC                       : 2026-09-22T02:56:08.000Z
AURA 1m bucket                 : 1790045760000  (02:56:00Z)
AURA 3m bucket                 : 1790045640000  (02:54:00Z)   exit → 1790046540000 (02:09:00Z)
```

The 1m and 3m grids are pure multiples; one conversion serves both (authoritative `bucketSec` from `BUCKET_SECONDS`). Conversion: `mt5ServerWallToBucketMs` in `frontend/src/services/mt5Time.ts` (fixed-point `Intl` offset — no fixed ±2/+3).

## 11. Candle-range verification

- Default chart: **GOLD**, `DEFAULT_HISTORY_HORIZON = "2w"`, `HISTORY_LIMIT = 2000` per page (`frontend/src/config/chart.ts`).
- The most recent real XAUUSD trades span **2026-09-04 → 2026-09-22** — inside a 2-week GOLD horizon ending today. The 49 GOLD overlays' entry buckets should exist among loaded candles.
- Older accounts' trades (July/August) fall **outside** the default 2-week window — their overlays exist in state but their candles are not loaded (they render only after "Load More History").
- Viewport: markers are painted via a series primitive regardless of scroll position; range/viewport was **not** modified during this audit.

## 12–15. buildTradeOverlays / TradingChart / Bridge / Primitive results

All measured in §8. Wiring verified statically: `App.tsx:1162 tradeOverlays={tradeOverlays}` → `TradingChart` (`instrumentEpic = epic = selectedEpic = "GOLD"`) → `visibleTradeOverlays` memo (TradingChart.tsx:1035–1041) → `TradeOverlayBridge` (1827–1832, `enabled={!session}`) → attaches `TradeOverlayPrimitive` to the main series, repaints on geometry change. **No stage drops GOLD overlays.**

## 16. Exact point where data disappears

**Not reproduced statically.** The two credible defect sites:

1. **App.tsx all-accounts loop (confirmed weakness):** ~35 sequential REST calls per sign-in; **any single failure clears the entire overlay layer** with only a console warning. Also slow, and account-unscoped (all accounts merged).
2. **Browser rendering (unverified):** no test asserts actual DOM/canvas painting of `TradeOverlayPrimitive`. Headless suites prove data and geometry, not pixels. A browser-level verification (or a rendering defect report) is required to close this.

## 17. Account mismatch behavior currently present in AURA

**None.** AURA cannot compare the selected account to the connected MT5 account: it never receives `account_info` (§5). `accounts.account_number` is partially populated (null on 5 accounts, one non-numeric value) and is not currently used for matching anywhere in the frontend. The dashboard's proven pattern (§4) is the reference implementation.

## 18. Recommended UX behavior (for the follow-up phase — NOT implemented)

1. Add an AURA account selector bound to the same `user_settings.default_account_id` persistence the dashboard uses (single source of truth across both apps; no second architecture).
2. Historical trades load **only for the selected account** (also fixes the 35-call loop and the all-or-nothing failure mode).
3. Surface the connected MT5 login (reuse pythonMt5 `account_info` via aura-backend — no new transport) and compute `mismatch = mt5Connected && mt5Login !== null && selected.account_number !== mt5Login` as a live computed value.
4. On mismatch: show the dashboard-style `role="alert"` banner; keep historical tied to the selection; **suppress live-overlay contributions from the mismatched MT5 account**; never auto-switch, never merge.
5. Warn (not fail) when `account_number` is null on the selected account — matching is then impossible and must say so.

## 19. Minimal required implementation changes (proposal only)

| Change | Files | Scope |
|---|---|---|
| Account selector state + UI | `frontend/src/App.tsx` (+ a small selector component) | selected account id → overlay feed calls `getTradingTrades(selectedId, …)` |
| MT5 login availability | aura-backend (existing socket already carries it) + one AURA backend passthrough route + `dashboardClient.ts` | smallest missing piece: expose `{login, server, connected}` for the user's MT5 service |
| Mismatch getter + banner | App.tsx / a header component | pure frontend comparison |
| (Optional) empty-instrument row hygiene | dashboard-side write path | 12 rows have `instrument = ""` |

## 20. Risks / edge cases

- `account_number` null/partial (5 accounts) and non-numeric (APEX) — matching must handle "unmatchable" explicitly.
- Multiple MT5 terminals / service pointed at a different broker than the selected prop-firm — display the server field, not just the login.
- DAX users will see nothing after an account selector lands (DAX40 unresolved) — expected by design; needs a UI hint, not a silent mapping.
- The all-accounts merge currently masks cross-account ticket collisions; the P3-B `account + ticket` key already handles this — keep it.
- Per-account 2 000-row cap truncates long histories (hasMore warning exists but is console-only).

---

### Final classification

- **ACCOUNT SELECTION problem** — confirmed (no selector; all-accounts merge; all-or-nothing failure clears overlays).
- **ACCOUNT MISMATCH problem** — confirmed missing capability (no MT5 identity in AURA).
- **RENDERING problem** — suspected but unproven (no browser-level verification exists; data path fully healthy).
- DATA/API ✅ · SYMBOL MAPPING ✅ (XAUUSD only, by design) · TIMESTAMP ✅ · **NO CURRENT DATA BUG FOUND**.

Scratch artifacts used for this audit (`backend/p3d-trace.mjs`, `backend/p3d-trace.out`, `backend/p3d-trades.json`, `frontend/tests/p3d-stage-counts.test.mjs`, `frontend/p3d-stages.out`) were **removed after the measurements**; only this report remains from P3-D.


