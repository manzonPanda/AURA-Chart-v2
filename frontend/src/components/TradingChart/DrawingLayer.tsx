import { useEffect, useRef, useState } from "react";
import {
  type DrawingController,
  type DrawingToolId,
} from "@getcandlekit/charts/react";
import {
  DrawingSync,
  drawingsToEngineJson,
  type DrawingSyncPhase,
} from "../../services/drawingPersistence";

/**
 * DrawingLayer — bridges one CandleKit DrawingController (one chart scope) to
 * AURA's server-side persistence and renders the drawing toolbar + sync chip.
 *
 * Mounted as a CHILD of <ChartView> so it can reach the ChartContext (which
 * carries the drawing plugin — and, on this chart, the native measurement
 * controller). Lifecycle:
 *
 *   1. scope (epic × timeframe) changes → fresh DrawingSync loads the persisted
 *      set from GET /api/drawings and restores it through engine.import()
 *      (guarded: the restore's engine emission is NOT echoed back to the API);
 *   2. every engine change (create / move / reshape / delete) is diffed and
 *      coalesced by DrawingSync → one debounced PUT per gesture;
 *   3. teardown flushes any unsaved snapshot fire-and-forget before the
 *      per-scope engine is destroyed.
 *
 * The toolbar is withheld until the server set is known (a save before restore
 * could replace drawings this browser never saw) and hidden during Replay.
 * Persistence failures keep drawings on screen and surface a Retry chip.
 */

/**
 * The drawing tools AURA actually exposes — a deliberate SUBSET of CandleKit's
 * sixteen. The engine still implements every one of them; the toolbar simply
 * does not offer the rest. Each entry is driven through `engine.startTool(id)`,
 * the exact call CandleKit's own toolbar makes, so tool behaviour (two-point
 * anchors, draft lifecycle, lock respect, persistence via `DrawingSync`) is
 * untouched.
 *
 * NOTE: CandleKit's `<DrawingToolbar>` is intentionally NOT used. It hard-codes
 * three extra buttons — Delete, **Clear all** and Lock — and AURA must not
 * expose a destructive "clear everything" action, nor duplicate the lock/delete
 * controls it owns itself. This component is the existing AURA toolbar; it is
 * being narrowed, not replaced by a second one.
 */
export const DRAWING_TOOLS: { id: DrawingToolId; label: string; title: string }[] = [
  { id: "TrendLine", label: "╱", title: "Trend Line" },
  { id: "Rectangle", label: "▭", title: "Rectangle" },
  { id: "DateRange", label: "↔|", title: "Date Range" },
];

/**
 * The ruler's tooltip — AURA's casing of CandleKit's own README help line,
 * minus the "% move" segment: the tooltip no longer surfaces the % row (hidden
 * by theming + MeasureTimeFmt — see styles.css and MeasureTimeFmt.tsx), so the
 * title must not promise it. It still promises pts, bars and time — exactly
 * what the readout shows (time in unit style, each part only when non-zero:
 * "1h 30m" | "45m" | "2h").
 */
export const MEASURE_TITLE = "Measurement Ruler — Shift-drag for points, bars · time";

/**
 * The AURA drawing control strip. Seven controls, nothing else:
 *
 *   Cursor/Select · Trend Line · Rectangle · Date Range
 *   ────────────────────────────────────────────────
 *   Delete Selected · Lock Drawings · Measurement Ruler
 *
 * All of it is chrome over `DrawingEngine` (select / startTool / removeSelected
 * / setLocked). The measurement button does not draw anything itself — it hands
 * the chart back to a non-drawing state so the library's NATIVE Shift-drag
 * ruler (MeasurementController) is not intercepted by an armed drawing tool.
 */
function DrawingToolsBar({ controller }: { controller: DrawingController }) {
  const engine = controller.engine;
  const [activeTool, setActiveTool] = useState<string | null>(() => engine.getActiveTool());
  const [locked, setLocked] = useState(() => engine.isLocked());
  const [hasSelection, setHasSelection] = useState(() => Boolean(engine.getSelectedId()));
  /** UI mode only — the ruler itself is the library's MeasurementController. */
  const [measuring, setMeasuring] = useState(false);

  // One subscription drives every reflected state: the engine emits on tool
  // change, select, mutation AND lock toggle, so no second source of truth.
  useEffect(
    () =>
      engine.onChange(() => {
        setActiveTool(engine.getActiveTool());
        setLocked(engine.isLocked());
        setHasSelection(Boolean(engine.getSelectedId()));
      }),
    [engine],
  );

  const cursorActive = activeTool === null && !measuring;

  const selectMode = (): void => {
    setMeasuring(false);
    engine.stopTool();
    setActiveTool(null);
  };

  const pickTool = (id: DrawingToolId): void => {
    setMeasuring(false);
    engine.startTool(id);
    setActiveTool(id);
  };

  const removeSelected = (): void => {
    // `removeSelected()` is already a no-op with nothing selected, and locking
    // clears the selection outright — this guard keeps the intent explicit.
    if (locked || !hasSelection) return;
    engine.removeSelected();
  };

  const toggleLock = (): void => {
    const next = !locked;
    engine.setLocked(next);
    setLocked(next);
    setHasSelection(Boolean(engine.getSelectedId()));
  };

  const toggleMeasure = (): void => {
    const next = !measuring;
    setMeasuring(next);
    // Leave drawing mode so an armed tool cannot swallow the Shift-drag in the
    // capture phase. Selection/delete/lock are all left exactly as they were.
    if (next) engine.stopTool();
  };

  return (
    <div className="drawing-toolbar" role="toolbar" aria-label="Drawing tools">
      <button
        type="button"
        className={`drawing-tool-btn${cursorActive ? " is-active" : ""}`}
        title="Cursor / Select"
        aria-label="Cursor / Select"
        aria-pressed={cursorActive}
        onClick={selectMode}
      >
        ↖
      </button>
      {DRAWING_TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          className={`drawing-tool-btn${activeTool === tool.id ? " is-active" : ""}`}
          title={tool.title}
          aria-label={tool.title}
          aria-pressed={activeTool === tool.id}
          onClick={() => pickTool(tool.id)}
        >
          {tool.label}
        </button>
      ))}

      <span className="drawing-toolbar-sep" aria-hidden="true" />

      <button
        type="button"
        className="drawing-tool-btn"
        title="Delete Selected"
        aria-label="Delete Selected"
        disabled={!hasSelection || locked}
        onClick={removeSelected}
      >
        ⌫
      </button>
      <button
        type="button"
        className={`drawing-tool-btn${locked ? " is-active" : ""}`}
        title={locked ? "Unlock Drawings" : "Lock Drawings"}
        aria-label={locked ? "Unlock Drawings" : "Lock Drawings"}
        aria-pressed={locked}
        data-locked={locked || undefined}
        onClick={toggleLock}
      >
        {locked ? "🔒" : "🔓"}
      </button>
      <button
        type="button"
        className={`drawing-tool-btn${measuring ? " is-active" : ""}`}
        title={MEASURE_TITLE}
        aria-label="Measurement Ruler"
        aria-pressed={measuring}
        onClick={toggleMeasure}
      >
        📐
      </button>
    </div>
  );
}

function SyncStatusChip({
  phase,
  detail,
  onRetry,
}: {
  phase: DrawingSyncPhase;
  detail?: string;
  onRetry: () => void;
}) {
  if (phase === "loading") {
    return <span className="drawing-status">Loading drawings…</span>;
  }
  if (phase === "saving") {
    return <span className="drawing-status">Saving…</span>;
  }
  if (phase === "saved") {
    return <span className="drawing-status drawing-status--ok">✓ Saved</span>;
  }
  if (phase === "error") {
    return (
      <button type="button" className="drawing-status drawing-status--error" title={detail} onClick={onRetry}>
        ⚠ Not saved — Retry
      </button>
    );
  }
  return null;
}

export interface DrawingLayerProps {
  /** Per-scope CandleKit controller from TradingChart (null ⇒ drawing off). */
  controller: DrawingController | null;
  /** Instrument epic — half of the drawing scope. */
  epic?: string;
  /** Timeframe id (MINUTE_1 | MINUTE_3 | MINUTE_5) — the other half. */
  timeframe?: string;
  /** Replay owns the chart: no tool may be started (toolbar hidden). */
  replayActive?: boolean;
}

export function DrawingLayer({ controller, epic, timeframe, replayActive }: DrawingLayerProps) {
  const [phase, setPhase] = useState<DrawingSyncPhase>("idle");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [restored, setRestored] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const syncRef = useRef<DrawingSync | null>(null);
  const restoringRef = useRef(false);

  const scopeReady = Boolean(controller && epic && timeframe);

  // (1) One DrawingSync per scope — load → restore → idle. Cleanup shuts the
  // sync down (flushing anything unsaved) before the next scope's engine lives.
  useEffect(() => {
    setPhase("idle");
    setDetail(undefined);
    setRestored(false);
    if (!controller || !epic || !timeframe) {
      syncRef.current = null;
      return;
    }
    const sync = new DrawingSync({
      scope: { epic, timeframe },
      onPhase: (next, why) => {
        setPhase(next);
        setDetail(why);
      },
    });
    syncRef.current = sync;
    let alive = true;
    sync
      .load()
      .then((drawings) => {
        if (!alive) return;
        // Restore is synchronous inside import(); the flag keeps the engine's
        // change emission from echoing the just-loaded set back to the server.
        restoringRef.current = true;
        try {
          controller.engine.import(drawingsToEngineJson(drawings));
        } finally {
          restoringRef.current = false;
        }
        setRestored(true);
      })
      .catch(() => {
        /* phase already "error" — the chip offers Retry */
      });
    return () => {
      alive = false;
      if (syncRef.current === sync) syncRef.current = null;
      sync.shutdown();
    };
  }, [controller, epic, timeframe, reloadTick]);

  // (2) Every engine change → the scope's sync (create/move/reshape/delete).
  useEffect(() => {
    if (!controller) return;
    const engine = controller.engine;
    const off = engine.onChange(() => {
      if (restoringRef.current) return;
      syncRef.current?.notifyChange(engine.getDrawings());
    });
    return off;
  }, [controller]);

  // "✓ Saved" settles back to quiet so the chip doesn't linger.
  useEffect(() => {
    if (phase !== "saved") return;
    const handle = setTimeout(() => setPhase("ready"), 1_600);
    return () => clearTimeout(handle);
  }, [phase]);

  const handleRetry = (): void => {
    if (restored) syncRef.current?.retryNow();
    else setReloadTick((n) => n + 1);
  };

  const showToolbar = scopeReady && restored && !replayActive;

  return (
    <div className="drawing-layer" aria-label="Chart drawings">
      {/* Toolbar FIRST: .drawing-layer is the vertical strip below the
          indicator legend, so the transient sync chip renders UNDER it and
          grows downward — the strip's position never shifts when the chip
          appears or disappears. */}
      {showToolbar && controller && <DrawingToolsBar controller={controller} />}
      <SyncStatusChip phase={phase} detail={detail} onRetry={handleRetry} />
    </div>
  );
}
