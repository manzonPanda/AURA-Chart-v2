# P3-A VERIFICATION REPORT — MT5 Server Time & Symbol Mapping

Status: **COMPLETE (P3-A only)** · Date: 2026-09-22
Scope: live measurement of the broker/server UTC offset + `symbols_get()` capture.
No overlay rendering, no live subscriber, no P1/P2 API-contract changes, no chart changes.
Preserved artifacts: all P2 code, `P3_AUDIT_REPORT.md` (unmodified).

---

## A. Actual observed MT5/server UTC offset

**Offset observed from the connected broker/server: +3 h 00 m 00 s (UTC+3), exact.**

Measurement (isolated, reusable utility
`MyTradingDashboard2/pythonMt5/mt5_p3a_diagnose.py` — kept as a permanent
diagnostic, see section G):

- Method: `symbol_info_tick(sym).time` (epoch seconds **on the broker server
  clock**) minus `time.time()` (true UTC) sampled at the same instant,
  100 samples across liquid probes (EURUSD, GBPUSD, USDJPY, XAUUSD), median
  snapped to whole seconds. No offset was assumed or hard-coded.
- Result: `offset_median_sec = 10799` → **+10799 s ≈ +2:59:59.7 → UTC+3 exact**
  (sub-second residual is request latency/quantisation noise).
- Hour-class distribution: **{+3: 100/100 samples}** — a single, stable offset
  across the whole sampling window; no intra-session drift or flip.
- Terminal context of the measurement: `login=112939808`,
  `server="MetaQuotes-Demo"`, `company="MetaQuotes Ltd."`, `connected=true`.

> Per the P3 audit, the production-timezone authority is The5ers
> (`MT5_SERVER_TIME_ZONE = 'Europe/Helsinki'` in `mt5-time.service.ts`).
> The connected profile for this measurement is **MetaQuotes-Demo**, which
> currently observes **EEST (Europe/Helsinki, UTC+3)** — identical to the
> The5ers model. See section C for DST handling and section G for the
> residual uncertainty about live The5ers accounts.

## B. Timestamp sample demonstrating the offset

From the same latest sample (raw diagnostic output):

| Quantity | Value |
|---|---|
| MT5 server tick time (EURUSD), rendered as if UTC | `2026-09-22T07:44:55+00:00` |
| True UTC at the same instant (`time.time()`) | `2026-09-22T04:44:54.64+00:00` |
| Delta | **+3:00:00** (median 10799 s over 100 samples) |

First 10 raw offsets (seconds): 10798.4, 10795.4, 10798.4, 10799.4, 10798.2,
10795.2, 10798.2, 10799.2, 10798.0, 10795.0 — all within +10795…+10799 s,
consistent with a whole-hour UTC+3 clock plus sub-second request latency
(second-quantised tick times).

## C. DST behavior/evidence

- **Live observation (today):** every sample classified to +3 h → the server
  is currently on **EEST (UTC+3)**. September 2026 is EU summer time, so this
  matches the EET/EEST model exactly.
- **Repo authority:** `mt5-time.service.ts:1-27` documents that MT5 brokers
  (incl. The5ers) run EET/EEST under **EU daylight-saving rules** — winter
  EET=UTC+2, summer EEST=UTC+3 — and deliberately resolves the offset per
  timestamp via IANA `Europe/Helsinki` instead of hard-coding +2/+3.
- **DST cannot be observed in a single session** (the switch happens twice a
  year). Evidence therefore combines: (1) today's measured +3 h equals EEST;
  (2) the documented broker-wide EET/EEST model. The P3-A diagnostic is
  retained so the offset can be re-measured automatically around the EU DST
  transition dates (last Sunday of March / October) to confirm empirically.
- **Conclusion for P3-B/C:** server-offset normalization must use the
  `Europe/Helsinki` IANA rule resolved **per timestamp** (the P3 audit spec),
  never a fixed +2/+3 constant.

## D. Exact MT5 XAUUSD symbol

`mt5.symbols_get()` (12,373 symbols total) gold-related capture:

| Symbol | Path | visible | select | digits | trade_mode | Verdict |
|---|---|---|---|---|---|---|
| **XAUUSD** | `Metals\XAUUSD` | **true** | **true** | 2 | 4 (full) | **spot gold — THE mapping target** |
| GOLD | `Nasdaq\Stock\GOLD` | false | false | 2 | 4 | Barrick Gold **equity** — NOT spot gold |
| XAUEUR/XAUAUD/XAUCHF/XAUGBP | `Metals\*` | false | false | 2 | 4/0 | cross pairs, not USD gold |
| XAUG | `Nasdaq\ETF\XAUG` | false | false | 2 | 4 | gold ETF, not spot |

- Exact spot symbol: **`XAUUSD`** — no broker suffix/prefix on this server.
- It is `visible=true, select=true` and actively ticking (used as a clock
  probe), so it is fully selectable/tradeable with no `symbol_select()` needed.
- ⚠️ **Trap confirmed:** a symbol literally named `GOLD` exists but is the
  Nasdaq-listed Barrick stock. Naive "contains GOLD" normalization would
  mis-map. The audit's `XAUUSD → GOLD` mapping must match on the **exact
  string `XAUUSD`** and reject the `Nasdaq\Stock\GOLD` path.

## E. Exact MT5 DAX-related symbol

DAX-related capture (all `visible=false, select=false` — none currently in
Market Watch, but all available via `symbol_select()`):

| Symbol | Path | digits | trade_mode | Verdict |
|---|---|---|---|---|
| **DE40** | `Indexes\DE40` | 2 | 0 (disabled on this demo) | **most plausible DAX CFD**, needs live verification |
| TECHDE30 | `Indexes\TECHDE30` | 2 | 0 | sector variant, not the headline index |
| DAX | `Nasdaq\ETF\DAX` | 2 | 4 | **ETF, NOT the index** (same trap as GOLD) |
| TDAX | `Nasdaq\ETF\TDAX` | 2 | 4 | ETF |
| HGER / GERN | `Nasdaq\ETF\HGER` / `Nasdaq\Stock\GERN` | 2 | 4 | unrelated ETF/equity noise |

- **No DAX mapping is finalized** (per instruction — not invented). Evidence
  points to **`DE40` under `Indexes\DE40`** as the candidate, but on this
  MetaQuotes-Demo profile `trade_mode=0` (trading disabled), so it cannot be
  confirmed by tick/deal activity here.
- **Required to finalize (P3-B):** capture `DE40` on the *live* The5ers
  profile (exists + `trade_mode` enabled + tick/deal evidence), or map from an
  actual historical DAX deal's `symbol` string in the dashboard DB.

## F. Final evidence-backed normalization mappings

| MT5 symbol (exact) | AURA Chart instrument | Evidence | Status |
|---|---|---|---|
| `XAUUSD` | `GOLD` | audit §F + live capture (`Metals\XAUUSD`, visible+selected, ticking) | **CONFIRMED — safe to implement in P3-B** |
| `DE40` | DAX-related AURA instrument | live capture shows `Indexes\DE40` exists; no trade evidence on demo profile | **CANDIDATE — pending live/deal verification** |
| `GOLD` (Nasdaq stock), `DAX`/`TDAX` (ETFs), XAU cross pairs | — | live capture | **MUST BE EXCLUDED** from matching |

Normalization rules derived from evidence (for P3-B implementation):
1. Match MT5 deal/position symbols by **exact name first** (`XAUUSD`), never
   by substring.
2. Reject symbols whose `path` starts with `Nasdaq\` when matching
   equities-named commodities/indices (`GOLD`, `DAX`, `TDAX` traps).
3. Suffix tolerance: none needed on this server (no suffixes observed); keep a
   defensive exact-match fallback list rather than regex guessing.

## G. Remaining uncertainty

1. **The5ers live offset not directly measured** — the connected profile was
   `MetaQuotes-Demo` (UTC+3 / EEST, matching the Helsinki model). The utility
   is account-agnostic; rerun it while a live The5ers account is logged in to
   certify that broker's offset. Until then, P3-B resolves offsets via
   `Europe/Helsinki` per-timestamp (the audit's verified approach), which
   today yields +3 h — identical to the measured value.
2. **DST switch not yet empirically observed** — scheduled re-runs of the
   diagnostic around the EU transition dates will confirm; rule-based
   `Europe/Helsinki` handling already covers it.
3. **DAX symbol unconfirmed** — `DE40` is evidence-backed but needs one
   live-profile capture or one historical deal to finalize.
4. **Tick time quantisation** — MT5 tick times are second-granular; the ±1 s
   band was removed by median sampling and cannot affect hour-level offsets or
   1 m/3 m candle bucketing.

---

## Files changed (P3-A)

| File | Change | Reason |
|---|---|---|
| `MyTradingDashboard2/pythonMt5/mt5_p3a_diagnose.py` | **NEW** — isolated, reusable, read-only diagnostic (offset measurement + symbol capture) | required capability; retained permanently for DST-transition re-verification |
| `AURA-Chart v2/P3A_VERIFICATION_REPORT.md` | **NEW** — this report | requested deliverable |

No other files touched. P1/P2 trading API contract, trade/chart timestamps,
and `P3_AUDIT_REPORT.md`: **unmodified**. No temporary artifacts remain.
