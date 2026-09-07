# Pine Engine: Piner (sole engine)

Status: **Removal COMPLETE (2026-09)** — Piner (`@heyphat/piner` 0.13.x) is the
ONLY Pine engine in AURA. The former AGPL dual-licensed engine was removed from
the dependencies, source, tests, factory and documentation of both the frontend
and the backend. There is no engine-selection switch and no fallback branch.

## Architecture (single engine)

```
AURA UI (PineBridge / pineImport / EmaBridge)
   │  PineScriptEngine (interface — services/pineEngineTypes.ts)
   │     setCandles / compute / computeScript / computeScriptVisuals / dispose
   ▼
PinerWorkerEngine (services/pineWorkerClient.ts)
   │  per-request ids + stale-run protection; transparent in-thread fallback
   │  (PinerPineEngine) under Node / no-DOM environments
   ▼
Web Worker (workers/pineEngine.worker.ts)
   ▼
Piner core (services/pinePinerCore.ts — pure, Node-testable)
   compile() + Engine(new ArrayFeed(bars)).run()   ← off the main thread
   outputs → PineVisual[] mapping (pineDrawings normalizers + LWC primitives)
   │
   ▼
AURA renderer (PineBridge.applyVisuals — series + primitives, unchanged)
```

Shared, engine-neutral modules (unchanged by the removal):

- `pineEngineTypes.ts` — the `PineScriptEngine` boundary + all shared visual
  types + `buildPineSymbolInfo` (syminfo with registry-driven mintick).
- `pineSeries.ts` — the authoritative full-OHLCV candle series builder.
- `pineMintick.ts` — mintick resolution (registry decimals → data estimate → floor).
- `pineDrawings.ts` — label/line/box drawing normalizers (engine-neutral).
- `pineIndicators.ts` — the built-in indicator registry (EMA Pine source).
- `pineImport.ts` — static validation, persistence, import pipeline (compiles
  via Piner and runs the preview through the same worker engine).

Backend: `src/emaAlert/pineEma.ts` compiles the SAME EMA Pine script with
Piner and runs it per alert evaluation (`inputs: { Period }` at run time —
one compile serves every period). There is no second EMA implementation: the
frontend `services/ema.ts` oracle remains only as a regression-test fallback.

## Boundary rules

1. `PineScriptEngine` is the ONLY surface React/App depend on. React never
   imports `@heyphat/piner` directly (the sole exception: `pineImport.ts`,
   which uses `compile()` for the input-metadata/settings schema).
2. `PineVisual[]` / `PineRuntimeDiagnostics` / drawing types are the shared
   chart-rendering contract — unchanged.
3. Replay / history / timeframe / instrument isolation is preserved by sending
   the same visible candle slice AURA already hands the engine; no future bars.
4. Stale-run protection: every request carries an id; the client ignores
   out-of-order/stale responses so an older run can never overwrite newer
   chart state.
5. No fake progress. Workers emit real stage boundaries (executing/extracting
   around the run; preparing/validating/transpiling/rendering in the pipeline).

## Testing requirements

- `tests/pinePiner.test.mjs` — engine gate: plots, styles, markers, drawings,
  syminfo.mintick, replay slice, concurrency, timeframe isolation, worker
  fallback, and the ~83k real-script migration gate.
- `tests/pineImport.test.mjs` — the import pipeline through the same engine.
- Backend `engineIntegration.test.ts` — the real Piner EMA adapter end-to-end.

A change is only shippable when the full frontend suite, the backend suite,
`typecheck` and the production builds are green, and the worker bundle is
emitted by `vite build`.
