# Diagnostic capture — bucket 09:06:00 UTC (2026-08-28), IX.D.DAX.IGM.IP

Captured via a temporary second backend instance (port 8799, now stopped).
Raw per-tick log preserved in `diag-capture.log`. No chart/frontend/live
candle behavior was changed.

## Session anchor

```
[3M CANDLE SESSION-START]
bucket=09:03:00
firstTick=09:05:35.719
firstTickDeltaMs=155719   ← joined mid-bucket (09:03 is PARTIAL — excluded from comparison)
ticksInBucket=1
O=26536.4
```

## [B] Our live closed candles

### Bucket 09:03 (PARTIAL — joined 2m36s late; reference only)

```
[3M CANDLE CLOSED]
bucket=09:03:00
O=26536.4
H=26537.8
L=26530.8
C=26532
ticks=47
firstTick=09:05:35.719
lastTick=09:05:59.985
firstTickDeltaMs=155719
lastTickDeltaMs=179985
rawO=26536.4 rawH=26537.8 rawL=26530.8 rawC=26532
lsUpdates=49 lsNoPrice=1 ticksTotal=48 clients=0
```

### Bucket 09:06 (FIRST COMPLETE BUCKET — comparison target)

```
[3M CANDLE CLOSED]
bucket=09:06:00
O=26532.2
H=26544.6
L=26529.9
C=26544.5
ticks=330
firstTick=09:06:00.348
lastTick=09:08:59.615
firstTickDeltaMs=348
lastTickDeltaMs=179615
rawO=26532.2 rawH=26544.6 rawL=26529.9 rawC=26544.5
lsUpdates=380 lsNoPrice=2 ticksTotal=378 clients=0
```

**Coverage is total**: first tick 0.35 s after the boundary, last tick 0.39 s
before the next boundary → the open is genuinely the first tick of the bucket
and the close is the last tick of it.

**Rounding had ZERO effect on this candle**: rawO/H/L/C equal the rounded
O/H/L/C — all extreme mids landed on 0.1-grid values. (In general (bid+offer)/2
of 0.1-grid quotes sits on a 0.05 grid; an x.x5 mid rounds half-up by +0.05→0.1.
This candle just never had an x.x5 extreme.)

**Chain reconciliation (no drops)**: 380 Lightstreamer updates − 2 updates
with no usable price = 378 usable ticks = 47 (bucket 09:03) + 330 (09:06) + 1
(the rollover trigger tick in 09:09). The log line counts match exactly.

## Tick-level facts (whole capture window, 644 logged tick blocks)

- Price fields used: 630 MID (bid+offer both present), 12 BID (offer absent),
  2 OFR (bid absent), **0 LTP — LTP was never present in any update**.
- 2 updates carried no usable price at all (counted, excluded from candles).
- UTM usable on every tick (no fallback-to-arrival warnings).
- **UTM runs ~+1.3–1.5 s AHEAD of server arrival time** (e.g. UTM
  09:05:35.719 arrived 09:05:34.436). Since IG stamps UTM at the feed, our
  UTM-based bucketing aligns with IG's own boundary assignment; the skew only
  matters within ~1.5 s of a boundary.

## [C] IG server-side 1-minute /prices re-aggregation — PENDING

`npm --prefix backend run ig:ohlc-compare` is ready but the IG historical-data
allowance is currently exhausted (403). Run the command again once the
allowance resets, then fill in the 09:06 bucket row below. It prints
quoteMid / midTraded / bid / ask OHLC for the newest six 3-minute buckets,
including 09:06.

| basis     | O | H | L | C |
|-----------|---|---|---|---|
| quoteMid  | – | – | – | – |
| midTraded | – | – | – | – |
| bid       | – | – | – | – |
| ask       | – | – | – | – |

## [A] IG website 3-minute candle for bucket 09:06 (user-read, 10:06 UK)

| source   | O | H | L | C |
|----------|---|---|---|---|
| IG site [A]  | 26532.9 | 26545.0 | 26530.5 | 26544.4 |
| ours [B] | 26532.2 | 26544.6 | 26529.9 | 26544.5 |
| IG − ours | +0.7 | +0.4 | +0.6 | −0.1 |

## [C] IG server-side 1-minute /prices re-aggregation — PENDING

`npm --prefix backend run ig:ohlc-compare` is ready but the IG historical-data
allowance is still exhausted (403 — retried 09:42 UTC, and again later in the
morning). Run the command again once the allowance resets, then fill in the
09:06 bucket row below. It prints quoteMid / midTraded / bid / ask OHLC for
the newest six 3-minute buckets, including 09:06.

| basis     | O | H | L | C |
|-----------|---|---|---|---|
| quoteMid  | – | – | – | – |
| midTraded | – | – | – | – |
| bid       | – | – | – | – |
| ask       | – | – | – | – |

## [B+] Tick-derived basis comparison for 09:06 (from our own captured stream)

Re-aggregating the 320 two-sided ticks of bucket 09:06 in `diag-capture.log`
by each raw side (BID-only / ASK-only / quote MID), same floor(ts/180) bucket:

| basis          | O | H (@time) | L (@time) | C |
|----------------|---|---|---|---|
| BID            | 26531.5 | 26543.9 @09:08:59.389 | 26529.2 @09:06:08.632 | 26543.8 |
| ASK (OFFER)    | **26532.9** | 26545.3 @09:08:59.389 | 26530.6 @09:06:08.632 | 26545.2 |
| MID (quote)    | 26532.2 | 26544.6 @09:08:59.389 | 26529.9 @09:06:08.632 | 26544.5 |
| **IG site [A]**| **26532.9** | 26545.0 | 26530.5 | 26544.4 |

IG site vs each basis (IG − basis):

| vs basis | O | H | L | C |
|----------|---|---|---|---|
| BID  | +1.4 | +1.1 | +1.3 | +0.6 |
| ASK  | **0.0** | −0.3 | −0.1 | −0.8 |
| MID  | +0.7 | +0.4 | +0.6 | −0.1 |

### Findings

1. **The IG site is NOT bid-basis** (offsets would be uniformly ≈ +1.4 with
   this 1.4-point spread; the close is only +0.6).
2. **NOT our quote-mid** (mixed signs +0.7/+0.4/+0.6/−0.1 — a basis shift
   cannot change sign).
3. **NOT pure ask-basis** (open matches EXACTLY, but H/L/C are −0.3/−0.1/−0.8).
4. **Open is not carried forward from the previous close** — last 09:03 quote
   was [26531.3, 26532.7] (mid 26532.0) at 09:05:59.985; IG's open 26532.9
   matches none of it, but equals the ASK of the first in-bucket quote
   [26531.5, 26532.9] at 09:06:00.348.
5. **Every IG value fits INSIDE our captured quote spreads as a trade print**:
   - O 26532.9 → exactly AT the ask of the first in-bucket quote (buy print).
   - H 26545.0 → inside the high-moment quote [26543.9, 26545.3].
   - L 26530.5 → inside the low-moment quote [26529.2, 26530.6].
   - C 26544.4 → inside the final quote [26543.8, 26545.2].
   A trade print must lie within the prevailing spread; all four IG values do,
   and none equals our quote-mid.
6. Our TICK stream carried **no LTP at all** (0 of 644 updates) — the stream
   we consume has no trade prints, while the site's values behave like them.

### Two surviving hypotheses (distinguished by [C])

- **H1 — trade-based candles**: the IG website chart is built from trade
  prints / `midTraded` (IG's internal candle store), not from quote mid.
  Predicts [C] shows: `quoteMid ≈ ours` AND `midTraded ≈ IG site`.
  Note: if H1 holds, live trade-based candles are impossible from the current
  TICK subscription (no LTP arrives) — the fix would be a different data
  source or accepting documented drift.
- **H2 — sampled tick stream**: the site uses quote-mid from IG's FULL server
  feed while our CHART:TICK stream is sampled/throttled (330 ticks / 3 min
  ≈ 1.8/s), so we miss quote extremes (−0.4 upside / −0.6 downside range).
  Predicts [C] shows: `quoteMid ≈ IG site` AND differs from ours.
  Fix under H2: source the live/forming candle from `/prices` (polling) or a
  richer subscription instead of tick aggregation.

Decision rule for [C] (one row decides):

- `quoteMid ≈ ours, midTraded ≈ site` → H1 (basis problem).
- `quoteMid ≈ site` → H2 (stream sampling problem).
- `quoteMid ≈ neither` → server 1m store timestamps differ from UTM
  bucketing (timestamp-basis problem).

