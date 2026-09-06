# Pine Engine Migration: PineTS → Piner

Status: **Migration gate PASSED (2026-09)** — Piner is the DEFAULT engine
(`AURA_PINE_ENGINE_BACKEND = "piner"`); the full frontend suite (352 tests incl.
the new `tests/pinePiner.test.mjs` migration-gate suite), typecheck and the
production build are green, with the 83k-script gate passing through the Piner
adapter. PineTS remains installed behind the same boundary (flip
`AURA_PINE_ENGINE_BACKEND` to `"pinets"`) for the sustained-session comparison
required by §6 before its removal.

## 1. Current architecture (before migration)

```
AURA chart truth (closed bars + WS forming candle)
   │  effectiveCloseSeries()  ← single EMA source, byte-identical to ema.ts oracle
   ▼
PineIndicatorEngine (services/pineEngine.ts)  ← PineTS 0.9.33
   ├─ setCandles(bars, liveCandle, bucketSec, symbol?)   authoritative candle slice
   ├─ computeScriptVisuals(spec, params, onError, onContext, onStage?)
   │      ├─ compile: new Indicator(source); indicator.input[varId]=value; prepare()
   │      ├─ execute: pine.run(indicator, klines.length)
   │      └─ extractVisuals(ctx) → PineVisual[] (lines/hist/area/hline/marker/labels/lines/boxes)
   ├─ compute(id, params)            ← built-in EMA 9/20 registry shim (EmaBridge)
   └─ dispose()
   │
   ▼
PineBridge.tsx / pineImport.ts  →  applyVisuals → LWC series + primitives
```

Direct PineTS imports: `pineEngine.ts` (PineTS, Indicator), `pineImport.ts`
(Indicator, input-metadata probe), `backend/src/emaAlert/pineEma.ts` (server EMA
alerts — out of scope, unchanged).

## 2. Why this is staged

PineTS works but (a) is AGPL/commercial dual-licensed, (b) compiles/executes
synchronously on the main thread (blocks UI on large scripts), and (c) is not
browser-first by design. Piner v0.13.0 is a clean-room, browser-first Pine v6
engine with a serializable visual IR (`OutputCollector` + `DrawObject[]`) that is
a natural fit for AURA's existing LWC rendering layer. The swap must not regress
the imported-indicator workflow (plots, markers, drawings, replay, history).

## 3. Piner v0.13.0 API (verified against installed package + probes)

```ts
compile(source, { libraries? })                      → CompiledScript (sync, pure)
new Engine(compiled, new ArrayFeed(bars), { backend? }) → Engine
engine.run({ symbol, timeframe, mintick? })           → Promise<void>   (bar_-by-bar)
engine.outputs                                       → OutputCollector (pure data, worker-serializable)
   .plots    Map<number, PlotSeries>   { id, title, data:number[], colors:(string|null)[], options }
   .markers  Map<number, MarkerSeries> { id, title, kind:'shape'|'char'|'arrow', location, glyph,
                                         data:(MarkerPoint|null)[] }
   .hlines   Map<number, HLine>        { id, price, title }
engine.drawings                                      → DrawObject[] { id, type:'label'|'line'|'box'|…, props }
engine.prepare(opts, bars) / step()                  → stepped historical replay
execution is deterministic; all time comes from the feed.
```

Verified probes:
- `syminfo.mintick`/`pricescale`/`minmove`/`pointvalue` = f(run.mintick); `tickerid` = run.symbol.
- Plot style enum: `line | stepline | area | histogram | columns` (+ `display:none`).
- Label/line/box live objects carry resolved props incl. `force_overlay`, `xloc`, `yloc`,
  TV hex colors `#RRGGBBAA` (AURA already parses those), and `label.set_*`/`delete` mutate
  the same object (matches the Pine drawing lifecycle).
- Piner `currency`/`timezone` syminfo fields are fixed at USD/UTC in v0.13.0 (RunOptions has no
  overrides) — documented AURA limitation; everything else derives from run.symbol/mintick.

## 4. Target architecture

```
AURA UI (PineBridge / pineImport)
   │  PineScriptEngine (interface — services/pineEngineTypes.ts)
   │     setCandles / computeScriptVisuals / dispose
   ├─ PineTS backend (existing PineIndicatorEngine, retained, selectable)
   └─ Piner backend (services/pinePinerEngine.ts)
          │  PineWorkerTransport (worker client | in-process, for tests/Node)
          ▼
      web worker (workers/pineEngine.worker.ts)
          ▼
      Piner core (services/pinePinerCore.ts — pure, Node-testable)
          compile() + Engine().run()   ← off the main thread
          piner → PineVisual[] mapping (reuses pineDrawings anchor helpers + LWC primitives)
          │
          ▼ structured response { visuales, diagnostics, stats, overlay }
   │
   ▼
   existing LWC renderer (PineBridge.applyVisuals — series + primitives, unchanged)
```

## 5. Migration boundary rules

1. `PineScriptEngine` is the ONLY surface React/App depend on. Piner calls live in
   the worker + `pinePinerCore.ts`; React never imports `@heyphat/piner`.
2. `PineVisual[]` / `PineRuntimeDiagnostics` / `PineLabelDrawing` / `PineLineDrawing` /
   `PineBoxDrawing` are the shared chart-rendering types — unchanged.
3. Authoritative candle building stays single-sourced in `services/pineSeries.ts`
   (extracted from pineEngine; PINETS + Piner both consume it).
4. Replay / history / timeframe / instrument isolation is preserved by sending the
   same visible candle slice AURA already hands the PineTS engine; no future bars.
5. Engine selection is a config constant (`AURA_PINE_ENGINE_BACKEND`); the app
   defaults to `piner`. PineTS path remains runnable for comparison.
6. Stale-run protection: every request carries a generation; the facade ignores
   out-of-order/stale responses so a slower older run can never overwrite new chart state.
7. No fake progress. Workers emit real stage boundaries (preparing/validating/
   transpiling happen in the import pipeline; executing/extracting/rendering
   around the worker round-trip).
8. `compute(id, params)` (built-in EMA 9/20 registry shim used by EmaBridge) and the
   backend EMA-alert `pineEma.ts` stay on PineTS — the migration targets the
   imported-script engine (the 83k-script path).

## 6. Removal gate (not yet reached)

Remove PineTS-specific code ONLY when: the real ~83k script executes under Piner
with matching visuals, the full frontend suite passes, typecheck+build are green,
and PineBridge/pineImport run with `AURA_PINE_ENGINE_BACKEND = 'piner'` for a
sustained session without diagnostics regressions.