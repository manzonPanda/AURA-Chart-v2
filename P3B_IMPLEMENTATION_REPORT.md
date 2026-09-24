# P3-B IMPLEMENTATION REPORT — Historical MT5 Trade Overlay

**Scope:** historical overlay only. No live subscriber, no new realtime transport,
no Supabase, no direct PostgreSQL access from AURA Chart. P2 and P3-A preserved.

---

## 1. Exact files changed

**AURA-Chart v2 (frontend):**
| File | Change |
|---|---|
| `frontend/src/services/mt5Time.ts` | **NEW** — pure Europe/Helsinki authority (UTC↔MT5 wall clock, per-timestamp DST) |
| `frontend/src/services/tradeOverlay.ts` | **NEW** — symbol normalization + `buildTradeOverlays` mapping + `formingBucketToMs` |
| `frontend/src/services/tradingApi.ts` | **NEW** (P2 service) + `pnl` added to `TradeRecord` |
| `frontend/src/components/TradingChart/TradeOverlayPrimitive.ts` | **NEW** — LWC canvas primitive (markers/band/SL/TP) |
| `frontend/src/components/TradingChart/TradeOverlayBridge.tsx` | **NEW** — React bridge (GapShading pattern) |
| `frontend/src/components/TradingChart/TradingChart.tsx` | +`tradeOverlays` prop (default `undefined`), visibility filter, bridge mount |
| `frontend/src/App.tsx` | +bounded overlay data feed (P2 chain), +`tradeOverlays` prop |
| `frontend/tests/tradeOverlay.test.mjs` | **NEW** — 15 focused tests (matrix A–L) |

**AURA-Chart v2 (backend):** **NO changes** (P2 untouched — the config/index.ts
diffs visible in git are the pre-existing P2 state, not P3-B work).

**MyTradingDashboard2 (aura-backend):**
| File | Change |
|---|---|
| `aura-backend/src/db/trading-overlay.js` | `TRADE_COLUMNS` whitelist: `+ pnl` (single column; template, params, read-only semantics unchanged) |

**Untouched:** `mt5_p3a_diagnose.py`, `P3A_VERIFICATION_REPORT.md`, all P2 files,
P1 route/auth/ownership logic (verified by the suites in §10–11).

## 2. Timestamp conversion implementation

`frontend/src/services/mt5Time.ts` — the browser twin of the authoritative
`mt5-time.service.ts` model (`MT5_SERVER_TIME_ZONE = 'Europe/Helsinki'`):

```
MT5 server wall clock (naive string)
  → parseMt5WallClock (strict "YYYY-MM-DD[ T]HH:MM[:SS]", 1970–2100)
  → utcMs = Date.UTC(parts)                          // parsed AS IF UTC
  → utcMs -= zoneOffsetMs('Europe/Helsinki', utcMs)  // subtract EET/EEST in force
  → fixed-point refinement (2nd pass)                // DST-safe, never hard-coded
  → mt5ServerWallToBucketMs(str, bucketSec) = floor(utcMs/1000/bucket)*bucket*1000
```

- Offset resolved **per timestamp** via `Intl.DateTimeFormat` (IANA DB) —
  EEST (UTC+3) and EET (UTC+2) both resolve automatically; nothing assumes +3.
- Unparsable/out-of-range input → `null` (never `Date.now()`, never 0).
- 1m: `floor(epoch/60)`; 3m: `floor(epoch/180)` — the authoritative AURA grid
  (same 60/180 constants as `resolutionToBucketSec`), NOT a separate aggregation.

## 3. Symbol normalization implementation

`normalizeMt5Symbol()` in `tradeOverlay.ts` — **exact, evidence-backed only**:

| MT5 symbol | AURA epic | Resolved | Evidence |
|---|---|---|---|
| `XAUUSD` | `GOLD` | ✅ | P3-A live: `Metals\XAUUSD`, visible, selected, digits=2 |
| `GOLD` (Nasdaq\Stock) | *(unresolved)* | ❌ | P3-A live: Barrick stock — must NEVER map to AURA GOLD |
| `DE40` | *(unresolved)* | ❌ | Candidate only; no live/deal evidence — raw preserved |

- Resolution is name-exact (no substrings, no suffix stripping: `XAUUSD_R` fails).
- Unresolved → `{ mt5Symbol, epic: raw, resolved: false }` — raw preserved,
  never silently mapped (DE40 stays `DE40`).
- Chart visibility (`TradingChart`): `o.resolved && o.epic === instrumentEpic`
  → GOLD shows XAUUSD trades; DAX shows nothing until DE40 is verified.

## 4. Historical trade data contract

`TradeOverlay` (frontend-internal, derived — upstream P1/P2 contract unchanged
except `+pnl`): `key` (`t:<ticket>` or composite
`t:<time_open>|<instrument>|<price_open>|<buy_sell>` — tickets never invented),
`epic`, `mt5Symbol`, `direction: "Buy"|"Sell"`, `entryBucketMs`,
`exitBucketMs|null`, `entryPrice/exitPrice/sl/tp/lots/pnl` (numbers|null), `rrr`,
`status: "open"|"closed"`, `resolved`. All P1 fields consumed: entry/exit time,
direction, lots, entry/exit price, SL, TP, MFE, MAE, RRR, account, symbol, pnl.

## 5. Overlay rendering architecture

Additive sibling of the existing primitives (audit §H):
- `TradeOverlayPrimitive` — series-attached LWC primitive (GapRegionsPrimitive
  pattern): entry arrow (▲ teal Buy / ▼ red Sell), exit cross (green profit /
  red loss via `pnl`), dotted entry→exit band (open trades: dashed to the forming
  bucket + "(open)" tail), SL dashed red line, TP dashed green line.
- Geometry: `timeToCoordinate(entryBucketMs/1000)`, prices via
  `series.priceToCoordinate` — pure presentation; never touches candle data,
  indicators, FVG/CSD, Fibonacci, DOL, drawing tools, controls, or realtime.
- `TradeOverlayBridge` feeds `setOverlays()`; repaints only on prop/visibility
  change; hidden during replay; zOrder bottom (candles always paint on top).

## 6. 1m behavior
Buckets on the 60s grid; markers/band per entry/exit bucket. One shared mapping.

## 7. 3m behavior
Same mapped geometry floored to the authoritative 180s bucket (the frontend
never invents its own aggregation). Entry and exit remain **independent events**
even inside the same slot (test L).

## 8. Open trade behavior
`exitBucketMs = null`; dashed band entry → forming bucket
(`liveCandle.time`, seconds→ms via `formingBucketToMs`) + "(open)" tail label.

## 9. SL/TP behavior
Horizontal dashed lines entry→exit (+tail when open); absent SL/TP → simply not
drawn; values are never invented (test K).

## 10–11. Test results & P2 regression

| Suite | Result |
|---|---|
| `frontend` full suite (`node --test tests/*.test.mjs`) | **552 tests, 0 fail, exit 0** — includes 15 new `tradeOverlay` tests (matrix A–L; e.g. "A: summer … EEST", "G: 'GOLD' … NEVER mapped", "H: unresolved DE40", "L: two trades sharing one candle" all ✔) |
| `frontend` typecheck (`tsc -b --noEmit`) | **exit 0** |
| `backend` typecheck (`tsc --noEmit`) | **exit 0** |
| P1 `aura-backend` `trading-overlay.test.mjs` (with pnl whitelist) | **35/35 PASS, exit 0** |
| P2 backend proxy/auth regression (`tradingProxy.test.ts` + `apiInstrumentRouting.test.ts`) | **23/23 pass, exit 0** |
| P2 runtime chain (live: frontend client→Hono→aura-backend→PostgreSQL) | **19/19 PASS** — 401 unauth, accounts 200, trades 200 (pnl SELECT executed against the real DB), state 200 with live-money null, foreign account 403, bad limit/status 400, "19/19 passed" |
| Full backend suite | verified green earlier this session; P3-B changed **no** backend TS files |

## 12. Remaining limitations
1. **DE40→DAX unverified** — preserved unresolved; no DAX overlay until live/deal
   evidence lands (P3-A's symbol capture is ready for that moment).
2. **Server offset is broker-dependent** — the Helsinki authority is verified live
   (P3-A: MetaQuotes-Demo observed UTC+3, 100/100 samples); per-account offset
   verification for production brokers (The5ers) reuses `mt5_p3a_diagnose.py`.
3. **Bounded data** — most-recent 2000 trades per account (P1 hard max); very old
   windows beyond the cap are not loaded by design (no unbounded requests).
4. **pnl** is null for rows stored without it (most historical rows) — the exit
   marker then styles neutral; no P/L value is fabricated.
5. The overlay hides during replay (live-trade markers would mislead on a
   simulated chart).

## 13. Exact next step for P3-C
Implement the **live MT5 subscriber** per audit §I: pythonMt5 bridge →
aura-backend (persist + publish on the existing SSE bus) → AURA backend
subscribes server-side and relays a new `trade` frame over the **existing `/ws`**
relay; the frontend then appends/removes `TradeOverlay`s of the same shape
(no new transport). The same phase fills the null live-money fields in the
account-state endpoint.

---
**Verification:** `git diff`/`git status` inspected (only intended files);
no Supabase, no `pg`, no WebSocket/EventSource/socket.io in any P3-B file
(grep-verified); P2 and P3-A artifacts untouched (`mt5_p3a_diagnose.py` byte-size
unchanged); no temporary files remain (all `p3b-*.log` removed and the temporarily
started aura-backend stopped — port 5001 restored to its prior state).
