# P3-D FOLLOW-UP — EXACT TRADE-TIME POSITIONING FORENSIC AUDIT
**Status: READ-ONLY. No source files modified. No fix implemented. No P4/AI.**
**Method:** real authenticated runtime (minted `public.sessions` row, deleted in
`finally`), production `mt5Time.ts` / `tradeOverlay.ts` imported directly, live
Lightweight Charts timeScale reached through the React tree
(TradeOverlayBridge ref → TradeOverlayPrimitive `.chart`), temporary page-level
read-only probes only (`tmp-p3d-verify/p3d-tz-containment.mjs`,
`exact-x-audit.mjs` + `exact-x-out.json`, `p3d-candle-neighbors.mjs`,
`mt5-history.json`).

> NOTE: the previously referenced `P3D_POSITION_ACCURACY_AUDIT.md` does NOT
> exist on disk, and its quoted conclusions (naive raw format, tickets
> 128602815…, "prices inside candle") contradict the retained raw probe output
> of that same session (`p3d-time-align-audit-output.txt`, which shows the SAME
> tickets as today with ISO-Z raws and `INSIDE? false`). This audit re-derives
> everything from live data and supersedes it.

## 1. EXACT ROOT CAUSE

Markers are displaced by **exactly 8 hours (28 800 s)** — a compound timezone
error, NOT a bucketing/coordinate/rendering defect:

1. **pythonMt5 stores naive MT5-server (Europe/Helsinki) wall-clock digits** in
   `trades.time_open` — e.g. `2026-09-23 15:10:55`
   (`pythonMt5/mt5_api.py` renders MT5's server-clock-based epochs via
   `fromtimestamp(..., tz=utc)` / `pd.to_datetime(unit='s')`, both of which
   yield server digits; DB `::text` and `/api/history` return identical digits;
   price containment proves DB−3h = true UTC — §4).
2. **node-postgres parses `timestamp without time zone` (OID 1114) as
   PROCESS-LOCAL time.** The dashboard backend runs with TZ = **Asia/Manila
   (UTC+8)**. `aura-backend/src/db/pool.js:59` installs an identity parser ONLY
   for `date` (OID 1082) — OID 1114 is unprotected — and
   `src/db/postgrest-compat.js:141` (`v instanceof Date ? v.toISOString() : v`)
   serializes the locally-constructed Date → the API emits
   **`"2026-09-23T07:10:55.000Z"` = stored digits − 8h with a FALSE `Z`.**
   (AURA's Hono proxy passes strings through verbatim — `dashboardClient.ts`
   contains no date code.)
3. **`mt5Time.ts mt5ServerWallToUtcMs` deliberately ignores the `Z` suffix**
   (regex captures digits only) and re-reads `07:10:55` as Europe/Helsinki
   wall clock (its documented P3-A contract: NAIVE input) → −3h →
   `04:10:55Z`.
4. True instant = `12:10:55Z`. **Final pipeline = true − 8 h.**

`mt5Time.ts`'s Helsinki logic is CORRECT for naive digits — the contract is
broken upstream: the API no longer delivers the naive digits P3-A verified.
Note the alternative ("take the API's Z at face value") would still be −5 h
wrong, so honoring the Z alone cannot fix this; the read path must stop
re-labeling local time as UTC.

## 2. TIMESTAMP TRACE (per trade, production `mt5Time.ts`)

| | T1 15981486 | T2 15966639 | T3 15847335 |
|---|---|---|---|
| raw API `time_open` | `2026-09-23T07:10:55.000Z` | `2026-09-23T05:33:56.000Z` | `2026-09-22T05:56:08.000Z` |
| DB digits (`::text`) | `2026-09-23 15:10:55` | `2026-09-23 13:33:56` | `2026-09-22 13:56:08` |
| pipeline exact (mt5Time on raw API) | 04:10:55Z | 02:33:56Z | 02:56:08Z |
| **TRUE exact (DB digits as Helsinki)** | **12:10:55Z** | **10:33:56Z** | **10:56:08Z** |
| Δ true−pipeline | **28 800 s** | **28 800 s** | **28 800 s** |
| TRUE epoch ms | 1790165455000 | 1790159636000 | 1790074568000 |
| TRUE 1m bucket | 12:10:00Z | 10:33:00Z | 10:56:00Z |
| TRUE 3m bucket | 12:09:00Z | 10:33:00Z | 10:54:00Z |
| overlay bucket (current code, 60s floor of pipeline) | 04:10:00Z | 02:33:00Z | 02:56:00Z |
| close: pipeline / TRUE / buckets 1m | 04:13:07 / **12:13:07Z** / 12:13 | 02:35:47 / **10:35:47Z** / 10:35 | 03:09:25 / **11:09:25Z** / 11:09 |

## 3. CONTAINMENT DECIDER (4 candidate readings × open+close × 3 trades)

`p3d-tz-containment.mjs`, inclusive windows (previous probe's
| D: DB digits as UTC | n/a (future) | OUT/OUT | OUT/OUT | 0/4 |

## 4. CAPITAL CANDLES AT THE TRUE TIME (prev / containing / next) + PRICE ACCURACY

**T1 15981486 · Buy 0.17 · sl 4312.19 tp 4326.47 · pnl 33.49 · open 4315.11 / close 4317.08**
- 1m open 12:10Z: prev 12:09 O4314.10 H4314.12 L4312.29 C4313.68 | **CONT O4313.60 H4315.95 L4313.00 C4315.88 → OPEN INSIDE, Δclose −0.77 (−0.0178%), Δopen +1.51** | next 12:11 O4315.85 H4316.92 L4315.76 C4316.44
- 1m close 12:13Z: **O4317.43 H4317.69 L4315.53 C4317.18 → CLOSE INSIDE, Δclose −0.10 (−0.0023%)**
- 3m open 12:09Z: prev 12:06 O4314.05 H4315.46 L4313.47 C4314.15 | **CONT O4314.10 H4316.92 L4312.29 C4316.44 → INSIDE, Δclose −1.33** | next 12:12 O4316.45 H4319.16 L4315.53 C4318.90
- 3m close 12:12Z: **INSIDE, Δclose −1.82 (−0.0421%)**

**T2 15966639 · Buy 0.21 · sl 4314.2 tp 4325.35 · pnl −34.86 · open 4316.52 / close 4314.93**
- 1m open 10:33Z: prev 10:32 O4317.51 H4318.88 L4317.45 C4317.97 | **CONT O4317.92 H4318.54 L4316.17 C4316.25 → INSIDE, Δclose +0.27 (+0.0063%), Δopen −1.40** | next 10:34 O4316.24 H4316.64 L4315.84 C4316.00
- 1m close 10:35Z: **O4316.08 H4316.08 L4314.92 C4315.23 → INSIDE, Δclose −0.30 (−0.0070%)** (exec price = 1 cent above the candle LOW)
- 3m open/close 10:33Z: **BOTH INSIDE, Δclose +1.29 / −0.30**

**T3 15847335 · Sell 0.11 · sl 4329.75 tp 4311.58 · pnl 134.42 · open 4325.51 / close 4313.22**
- 1m open 10:56Z: prev 10:55 O4327.99 H4328.50 L4326.33 C4326.49 | **CONT O4326.46 H4326.63 L4325.30 C4325.98 → INSIDE, Δclose −0.47 (−0.0109%), Δopen −0.95** | next 10:57 O4325.96 H4326.00 L4324.43 C4324.45
- 1m close 11:09Z: **O4315.10 H4317.81 L4309.06 C4310.27 → INSIDE, Δclose +2.95 (+0.0684%)**
- 3m open 10:54Z: prev 10:51 … | **CONT O4328.75 H4328.75 L4325.30 C4325.98 → INSIDE, Δclose −0.47** | next 10:57 …
- 3m close 11:09Z: **INSIDE, Δclose −0.24 (−0.0056%)**

**12/12 containment PASS; |Δ| vs candle close ≤ 0.0684 %.** At the CURRENT
(pipeline) positions every check fails by **$8–30** — the visible symptom.

## 5. BUY/SELL PRICE SEMANTICS
MT5 Buy fills at Ask, Sell at Bid; the Capital candle is the bid-side feed.
Measured deltas vs candle close: −0.77 / −0.10 / +0.27 / −0.30 / −0.47 / +2.95 —
all INSIDE [L,H], no systematic sign by direction, all ≤ one spread on gold.
**No spread correction required; execution price stays authoritative.**
The large $17–30 deltas seen at the CURRENT marker positions are a
CONSEQUENCE of the 8h X displacement (candles 8h earlier traded elsewhere),
not a price defect.

## 6. buildTradeOverlays() OUTPUT (verbatim, production code)
- Timestamp: floored to 60 s (`mt5ServerWallToBucketMs`) — **exact ms
  discarded**; App.tsx:548 calls `buildTradeOverlays(res.trades, 60)`
  **hard-coded**, regardless of chart timeframe.
- Price: raw execution price, unmodified (Δ = 0.00000 on all 6 endpoints).
- Direction/instrument: verbatim / table-mapped (Buy ⇔ exact "Buy").
- Overlay fields written: `key, mt5Symbol, epic, resolved, direction,
  entryBucketMs, exitBucketMs, entryPrice, exitPrice, sl, tp, lots, pnl, rrr,
  status` — **NO exact-timestamp field exists** (§16 Q3).

## 7. TradeOverlayPrimitive COORDINATES (read-only)
- X: `timeScale.timeToCoordinate(overlay.entryBucketMs / 1000)` (line 163);
  **`continue` when null** ("entry candle not a registered time point", L164).
- Y: `series.priceToCoordinate(overlay.entryPrice)` (L165) — same API the
  candles use → **Y mapping exact by identity**.
- Exit: `timeToCoordinate(exitBucketMs/1000)` (L192, L244) with the same
  null-skip; band drawn only when BOTH ends resolve.

## 8. LIVE PIXEL COMPARISON (real chart, barSpacing = 9 px, both TFs)

| | T1 entry | T2 entry | T3 entry |
|---|---|---|---|
| **1m: current overlay X (= its bucket candle X)** | 51831.5 (04:10:00Z) | 50958.5 (02:33:00Z) | 38745.5 (02:56:00Z) |
| **1m: TRUE candle X** | 56151.5 (12:10:00Z) | 55278.5 (10:33Z) | 43065.5 (10:56Z) |
| **1m: deltaX current→TRUE** | **+4320.0 px** | **+4320.0 px** | **+4320.0 px** |
| 1m: TRUE exact-time X (interpolated) | 56159.75 | 55286.9 | 43066.7 |
| 1m: intra-candle delta (exact − bucket) | **+8.25 px** | **+8.40 px** | **+1.20 px** |
| **3m: current overlay X** | **NOT DRAWN** (ttc=04:10→**null**) | −80.5 (on-grid 02:33) | **NOT DRAWN** (ttc=02:56→**null**) |
| 3m: TRUE candle X | 1647.5 (12:09Z) | 1359.5 (10:33Z) | −2717.5 (10:54Z) |
| 3m: deltaX current→TRUE | **+1440.0 px** (interpolatable) | **+1440.0 px** | **+1440.0 px** |
| 3m: intra-candle delta (exact − bucket) | +5.75 px | +2.80 px | +6.40 px |
| Y(entry) = priceToCoordinate(exec) 1m | 127.04 | 106.59 | −23.76 |
| deltaY vs expected Y | **0.0 px (same call)** | **0.0** | **0.0** |
| Y vs TRUE candle body | inside [L,H] (Δclose −0.77 ≈ 11 px @ −14.1 px/$) | inside (≈ 3.8 px) | inside (≈ 6.6 px) |

- deltaX current→TRUE is **EXACTLY uniform** (4320.0 = 480 bars × 9 px @1m;
  1440.0 = 160 bars × 9 px @3m) across all trades → **pure time displacement,
  zero coordinate-mapping noise** (F/G/H/I clean).
- EXIT: same +8h; intra-candle: T1 12:13:07 → +1.05 px (1m) / +3.35 px (3m);
  T2 10:35:47 → +7.05 px / +8.35 px; T3 11:09:25 → +3.75 px / +1.25 px.
- Paint counters during the probe = 0 because the viewport excluded the
  marker slots (edge margin 32 px) — fully explained by the measured X
  values above (T1@3m x=207.5 drawn only if registered… it is NOT: null-skip;
  T2 x=−80.5 < −32 → skipped; T3 null-skip).

## 9. 1m VS 3m
- The 8h misalignment **exists on BOTH** timeframes (4320 px @1m, 1440 px @3m,
  exactly uniform). It is NOT timeframe-dependent.
- **Additional 3m-only defect (live-proven):** overlays are always built with
  60 s buckets (App.tsx:548), so on the default **3m** chart a bucket like
  04:10:00 / 02:56:00 (minute % 3 ≠ 0) is **not a registered point** →
  `timeToCoordinate` → **`null`** → primitive `continue` → **the entry marker
  is never drawn** (T1, T3 above; `directTtc: "null"` in the probe). Only
  buckets whose minute % 3 == 0 resolve (T2). Exit rings/bands fail the same
  way → **~2/3 of entries and most bands silently do not render on 3m.**
- The intra-cucket (exact-vs-bucket) snap exists on both TFs and is ≤ 1 bar
  (1.20–8.40 px @1m; 2.80–6.40 px @3m).

## 10. ENTRY VS EXIT (independent)
- **Both shifted by the same +8h** (systematic — one clock error).
- Bucket-floor losses are independent per endpoint (true-time mm:ss preserved
  by a whole-hour shift): entry/exit = T1 −55 s / −7 s, T2 −56 s / −47 s,
  T3 −8 s / −25 s. Neither endpoint is systematically worse; both floor toward
  the past.

## 11. DISPLAY TIMEZONE
Chart labels render Asia/Manila, but all internal chart times are UTC epoch
(`TradingChart.tsx:1317-1323` — "Data timestamps stay UTC epoch seconds
everywhere … only the RENDERED labels … are formatted in Philippine time").
The probe read the chart's internal `timeScale` directly. Display formatting is
NOT involved (it would move axis labels and markers together → deltaX = 0).

## 12. CONSOLIDATED FORENSIC TABLE

| Field | Trade 1 | Trade 2 | Trade 3 |
|---|---|---|---|
| Ticket | 15981486 | 15966639 | 15847335 |
| Direction | Buy 0.17 | Buy 0.21 | Sell 0.11 |
| Raw MT5 open (API) | 2026-09-23T07:10:55.000Z | 2026-09-23T05:33:56.000Z | 2026-09-22T05:56:08.000Z |
| DB digits | 2026-09-23 15:10:55 | 13:33:56 | 13:56:08 |
| Normalized TRUE UTC open | 2026-09-23 12:10:55Z | 10:33:56Z | 10:56:08Z |
| Open candle (1m TRUE) | 12:10 O4313.60 H4315.95 L4313.00 C4315.88 | 10:33 O4317.92 H4318.54 L4316.17 C4316.25 | 10:56 O4326.46 H4326.63 L4325.30 C4325.98 |
| MT5 open price | 4315.11 | 4316.52 | 4325.51 |
| Open price delta | −0.77 (−0.018%) INSIDE | +0.27 (+0.006%) INSIDE | −0.47 (−0.011%) INSIDE |
| Overlay X (1m, current) | 51831.5 | 50958.5 | 38745.5 |
| Candle X (1m, TRUE) | 56151.5 | 55278.5 | 43065.5 |
| deltaX (1m) | +4320.0 | +4320.0 | +4320.0 |
| Exact-time X (1m, TRUE) | 56159.75 | 55286.9 | 43066.7 |
| intra-candle X delta (1m) | +8.25 | +8.40 | +1.20 |
| Overlay Y (1m) / expected Y / deltaY | 127.04 / 127.04 / **0.0** | 106.59 / 106.59 / **0.0** | −23.76 / −23.76 / **0.0** |
| Raw MT5 close (API) | 07:13:07.000Z | 05:35:47.000Z | 06:09:25.000Z |
| Normalized TRUE UTC close | 12:13:07Z | 10:35:47Z | 11:09:25Z |
| Close candle (1m TRUE) | 12:13 O4317.43 H4317.69 L4315.53 C4317.18 | 10:35 O4316.08 H4316.08 L4314.92 C4315.23 | 11:09 O4315.10 H4317.81 L4309.06 C4310.27 |
| MT5 close price | 4317.08 | 4314.93 | 4313.22 |
| Close price delta | −0.10 (−0.002%) INSIDE | −0.30 (−0.007%) INSIDE | +2.95 (+0.068%) INSIDE |
| Close deltaX (1m) | +4320.0 | +4320.0 | +4320.0 |
| Close intra-candle X delta (1m) | +1.05 | +7.05 | +3.75 |

## 13. ROOT-CAUSE CLASSIFICATION

| Code | Selected? | Evidence |
|---|---|---|
| A. timestamp interpretation | partial | mt5Time's digit-reading is correct for its NAIVE contract; the contract itself is violated upstream |
| **B. timezone conversion** | **✓ PRIMARY** | naive Manila-local Date parse of Helsinki digits + false-Z (`pool.js:59` missing OID-1114 parser; `postgrest-compat.js:141`) then Helsinki re-shift → net **−8h**; containment 6/6 (C) vs 0/6 (B); displacement exactly 28 800 s = uniform 4320/1440 px |
| C. candle bucket calculation | ✗ | floors arithmetically correct on both grids |
| **D. 1m → 3m time mapping** | **✓ SECONDARY** | App.tsx:548 hard-codes 60 s → 3m `timeToCoordinate` null → markers skipped (live-proven: 2 of 3 entries not drawn on default 3m) |
| E. price semantics | ✗ | 12/12 execution prices inside true candle [L,H], ≤0.068% — no spread correction needed |
| F. price-axis coordinate conversion | ✗ | Y = priceToCoordinate(exec) — identity, deltaY = 0.0 px |
| G. time-axis coordinate conversion | ✗ | deltaX exactly uniform (4320/1440 px), zero noise |
| H. rendering primitive geometry | ✗ | draws exactly where told; null-skip is L164 by design |
| I. chart viewport/scale issue | ✗ | visible range + 32 px edge margin fully explain the 0 paint counts |
| J. no actual mismatch — perception | ✗ | mismatch real: 8h + (on 3m) missing markers |

Plus the product question's own item: the **exact-vs-bucket snap (≤1 bar,
1.2–8.4 px)** is a data-model limitation (bucket-only fields), not a defect of
the coordinate system.

## 14. ACCEPTANCE CHECK (task §14)
- ENTRY/EXIT **price** → correct chart price coordinate ✓ (raw execution price,
  never replaced by OHLC; inside the true candle's body).
- ENTRY/EXIT **time** → correct chart time coordinate ✗ — currently 8h early
  (and on 3m often not rendered at all). Acceptance NOT met until B (+D) fixed;
  intra-cucket exactness (≤1 bar) is a further, separable step.

## 15. ANSWERS TO THE FIVE PRODUCT QUESTIONS

**Q1 — Are markers currently bucket-start aligned?**
**YES.** `TradeOverlay` stores only `entryBucketMs`/`exitBucketMs` (floored at
60 s, hard-coded in App.tsx:548); the primitive resolves
`timeToCoordinate(bucket)`; the live probe shows `frac = 0, method = direct`
for every registered bucket on 1m — the marker sits at the candle's left edge
(intra-candle error vs exact time = 1.20–8.40 px @1m, 2.80–6.40 px @3m,
≤ 1 bar). Caveat: on the default 3m chart most 1m buckets are not registered
at all → not drawn.

**Q2 — Can Lightweight Charts position at the exact trade timestamp?**
**Not through `timeToCoordinate` — live-proven `null` for non-registered
times** (`exactNonRegisteredPipeline: "null"`, `exactNonRegisteredTrue:
"null"` vs `registeredBucket: 51831.5`), and **`logicalToCoordinate(5.5)` →
`0`** (fractional logicals collapse to the left edge — matches the LWC source
`!isInteger(index) → return 0` and the in-repo comment at
`pineDrawings.ts:285-290`). **BUT exact positioning IS achievable**: linear
interpolation between the two bracketing registered points' own
`timeToCoordinate` values — `x0 + (x1−x0)·(exact−t0)/(t1−t0)` — returned
valid, precise coordinates for every trade on both TFs, and this codebase
ALREADY implements exactly that pattern in
`pineDrawings.fractionalLogicalToCoordinate` (pineDrawings.ts:297-326).
Requirement **B (exact execution-time alignment) is technically supported** —
via interpolation, not via the direct API.

**Q3 — Does the architecture preserve exact timestamps?**
**NO.** `TradeOverlay` carries only bucket-floored ms; the exact ms is
discarded inside `mt5ServerWallToBucketMs`. The exact time IS available
upstream — the raw `time_open` string has second precision and
`mt5ServerWallToUtcMs()` already returns exact ms — so preservation is a small
additive model change (`entryExactMs`/`exitExactMs`); no API change needed.

**Q4 — Would switching bucket→exact affect candle alignment?**
**No.** Candles are independent series data the primitive never touches. The
marker moves right within its own candle by the intra-cucket fraction
(≤ 1 bar: 1.20–8.40 px @1m, 2.80–6.40 px @3m, measured on the live chart);
band, SL/TP and exit ring shift consistently. Axis/crosshair behavior is
unchanged (UTC epoch internals, Manila is label formatting only).

**Q5 — Smallest correct implementation change (RECOMMENDATION ONLY — NOT
IMPLEMENTED):**
1. **PREREQUISITE — fix the 8h error first** (otherwise exact positioning
   precisely paints the wrong time): add an identity type parser for OID 1114
   (`timestamp without time zone`) in
   `MyTradingDashboard2/aura-backend/src/db/pool.js` beside the existing
   OID-1082 line, so naive server digits reach the API verbatim — restoring the
   documented contract `mt5Time.ts` was written against. Taking the API's `Z`
   at face value is NOT a fix (still −5h wrong); the false `Z` must stop being
   produced.
2. Add nullable `entryExactMs`/`exitExactMs` to `TradeOverlay`, populated from
   `mt5ServerWallToUtcMs` in `buildTradeOverlays` (keep the bucket fields).
3. In `TradeOverlayPrimitive`, resolve X by interpolating between the
   bracketing registered points' `timeToCoordinate` values using
   `(exact − chartGridFloor)/chartBucketSec` — reuse the proven `pineDrawings`
   pattern; pass the chart's `bucketSec` through `TradeOverlayBridge` (it
   already passes `formingBucketSec`).
4. Replace the `continue`-on-null (TradeOverlayPrimitive.ts:163-168) with the
   interpolation fallback — which also repairs the 3m rendering gap (D) for
   free, since a 1m-bucketed time interpolates cleanly between bracketing 3m
   points.

**STOP.** No P4. No AI. No unrelated refactoring. No source changes made.




`before=anchor+10800` had excluded the digits-minute candle):

| Reading | T1 | T2 | T3 | Score |
|---|---|---|---|---|
| A: API digits as UTC | OUT/OUT | OUT/OUT | IN/OUT | 1/6 |
| **B: API digits as Helsinki (CURRENT CODE)** | OUT/OUT | OUT/OUT | OUT/OUT | **0/6** |
| **C: DB digits as Helsinki → true UTC** | **IN/IN** | **IN/IN** | **IN/IN** | **6/6 ★** |
| D: DB digits as UTC | n/a (future) | OUT/OUT | OUT/OUT | 0/4 |
