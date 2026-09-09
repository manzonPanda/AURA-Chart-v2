/**
 * AURA Chart — realtime candlestick chart with a 1m / 3m timeframe selector.
 * Priority: realtime stream (Lightstreamer → WS → chart) even if historical
 * REST is unavailable (e.g. IG_ALLOWANCE_EXHAUSTED).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TradingChart } from "./components/TradingChart/TradingChart";
import { IndicatorsMenu } from "./components/Indicators/IndicatorsMenu";
import {
  IndicatorSettingsModal,
  type SettingsApply,
  type SettingsTarget,
} from "./components/Indicators/IndicatorSettingsModal";
import {
  DEFAULT_TIME_FRAME,
  HISTORY_LIMIT,
  INSTRUMENT_LABEL,
  TIMEFRAMES,
  type TimeFrameKey,
} from "./config/chart";
import { loadEmaSettings, saveEmaSettings, type EmaSettings } from "./config/emaSettings";
import { loadSmaSettings, saveSmaSettings, type SmaSettings } from "./config/smaSettings";
import {
  loadChartSettings,
  saveChartSettings,
  type ChartSettings,
} from "./config/chartSettings";
import { ApiError, fetchCandlesDb, fetchHealth } from "./services/api";
import {
  canLoadMore,
  cursorFrom,
  INITIAL_HISTORY_STATUS,
  isExhausted,
  mergeOlderCandles,
  type HistoryStatus,
} from "./services/historyPagination";
import { useInstruments } from "./services/useInstruments";
import {
  compileImportedPine,
  loadImportedPineIndicators,
  MAX_IMPORTED_INDICATORS,
  saveImportedPineIndicators,
  type ImportedPineIndicator,
  type PineImportOutcome,
  type PineRunStatus,
  type PineSymbolMeta,
  type PineCompileStage,
} from "./services/pineImport";
import { useRealtimeStream, resolutionToBucketSec } from "./services/realtime";
import { iso } from "./services/diagnostics";
import { mergeGapLists } from "./services/gapRegions";
import type { Candle, CandleGap } from "./types/candle";
import { EmaAlertControl } from "./components/EmaAlert/EmaAlertControl";
import { OHLCReadout } from "./components/TradingChart/OHLCReadout";
import {
  DEFAULT_EMA_ALERT_SETTINGS,
  fetchEmaAlert,
  saveEmaAlertSettings,
  sendTestPush,
  type EmaAlertSettings,
  type EmaAlertState,
} from "./services/emaAlertApi";
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushAvailability,
  type PushAvailability,
} from "./services/pushClient";

/** A LIVE socket whose last real tick is older than this shows as
 *  "CONNECTED · NO TICKS" — a connected Lightstreamer is NOT live data. */
const TICK_STALE_MS = 240_000; // stale after 4 min with no fresh tick
/** Re-render cadence for tick-age display. */
const NOW_TICK_MS = 5_000;

/** Truthful stream label: LIVE only while real ticks are fresh. */
function streamLabel(status: string, lastTickAt: number, now: number): {
  label: string;
  live: boolean;
  noTicks: boolean;
  ageSec: number | null;
} {
  const ageSec = lastTickAt > 0 ? Math.max(0, Math.round((now - lastTickAt) / 1000)) : null;
  if (
    status === "LIVE" &&
    (lastTickAt <= 0 || (ageSec !== null && ageSec * 1000 > TICK_STALE_MS))
  ) {
    return { label: "CONNECTED · NO TICKS", live: false, noTicks: true, ageSec };
  }
  if (status === "LIVE") return { label: "LIVE", live: true, noTicks: false, ageSec };
  return { label: status, live: false, noTicks: false, ageSec };
}

export default function App() {
    const [candles, setCandles] = useState<Candle[]>([]);
  const [gaps, setGaps] = useState<CandleGap[]>([]);
  // Instrument selection (Phase 3) — the BACKEND REGISTRY (GET /api/instruments)
  // is the source of truth; localStorage only persists WHICH entry is active.
  // selectedEpic is "" until the catalog resolves → WS/history then run WITHOUT
  // an epic param → the backend serves its default (DAX): the historic behavior.
  const { catalog, selectedEpic, selected: selectedInstrument, selectInstrument } = useInstruments();
  const epic = selectedEpic;

  /**
   * Active instrument → syminfo metadata. Derived from the backend
   * registry (NEVER hardcoded): `decimals` drives `syminfo.mintick` (DAX 1 →
   * 0.1, Spot Gold 2 → 0.01) and the instrument calendar supplies the
   * session timezone. Memoized on identity so per-frame renders hand the
   * SAME object to PineBridge (whose engine guards re-runs by value anyway).
   */
  const pineSymbol: PineSymbolMeta | null = useMemo(() => {
    if (!selectedInstrument) return null;
    return {
      tickerid: selectedInstrument.epic,
      decimals: selectedInstrument.decimals,
      ...(selectedInstrument.calendar?.timezone ? { timezone: selectedInstrument.calendar.timezone } : {}),
    };
  }, [selectedInstrument]);
  /** Epic reported by the last successful history load (display fallback). */
  const [historyEpic, setHistoryEpic] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true); // TradingView-style follow
  const [historyMissing, setHistoryMissing] = useState(false);
  const [health, setHealth] = useState<{ configured: boolean; environment: string } | null>(null);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [timeframe, setTimeframe] = useState<TimeFrameKey>(DEFAULT_TIME_FRAME);
  // EMA overlay configuration — localStorage-persisted, frontend-only (never
  // Supabase; EMA VALUES are always derived client-side from the candles).
  const [emaSettings, setEmaSettings] = useState<EmaSettings>(loadEmaSettings);
    // SMA overlay configuration — localStorage-persisted, frontend-only (never
  // Supabase; SMA VALUES are always derived client-side from the candles).
  const [smaSettings, setSmaSettings] = useState<SmaSettings>(loadSmaSettings);
  // Imported Pine indicators — script source + settings ONLY (localStorage,
  // versioned `aura.pine.indicators`). Values are always recomputed by the
  // Piner engine against the selected timeframe's candles.
  const [importedPine, setImportedPine] = useState<ImportedPineIndicator[]>(loadImportedPineIndicators);
  // Chart display settings (e.g. Invert Scale) — localStorage-persisted in
  // App, frontend-only presentation state that never touches candle data.
  // ⚠ TEMP debug hook (?debugInvert): `?invert=1|0` seeds/forces the setting so
  // headless reproduction runs can pin OFF vs ON. Absent the flag, the normal
  // localStorage load is used and nothing changes.
  const [chartSettings, setChartSettings] = useState<ChartSettings>(() => {
    const loaded = loadChartSettings();
    try {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("debugInvert")) return loaded;
      const forced = params.get("invert");
      if (forced === "1" || forced === "0") {
        const seeded: ChartSettings = { invertScale: forced === "1" };
        saveChartSettings(seeded);
        return seeded;
      }
    } catch {
      /* no window / blocked storage — fall through to the normal load */
    }
    return loaded;
  });
  // Session runtime status per imported indicator (never persisted).
  const [pineStatuses, setPineStatuses] = useState<Record<string, PineRunStatus>>({});
  const requestSeq = useRef(0);
  // EMA Reversal Alerts — server-side detection + Web Push. The backend is the
  // source of truth (settings + state); the browser only configures + displays.
  const [emaAlertSettings, setEmaAlertSettings] = useState<EmaAlertSettings | null>(DEFAULT_EMA_ALERT_SETTINGS);
  const [emaAlertState, setEmaAlertState] = useState<EmaAlertState | null>(null);
  const [emaAlertSaving, setEmaAlertSaving] = useState(false);
  const [pushAvail] = useState<PushAvailability>(() => pushAvailability());
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushWorking, setPushWorking] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);

  // ── Unified header — market strip + replay entry (old bottom footer gone) ──
  // `quoteCandle` (timestamp · O H L C · change · Range) is OWNED by
  // TradingChart (crosshair hover ?? replay cursor ?? latest bar) and pushed up
  // via onQuoteCandle; App only mirrors it for presentation. The setter is
  // value-guarded on the rendered fields (ts/OHLC), so the fresh object
  // identities the chart mints on renders that change no displayed value can
  // never loop renders.
  const [quoteCandle, setQuoteCandle] = useState<Candle | null>(null);
  const handleQuoteCandle = useCallback((c: Candle | null) => {
    setQuoteCandle((prev) => {
      if (prev === c) return prev;
      if (
        prev && c &&
        prev.ts === c.ts &&
        prev.open === c.open &&
        prev.high === c.high &&
        prev.low === c.low &&
        prev.close === c.close
      ) {
        return prev;
      }
      return c;
    });
  }, []);
  // Replay ENTRY: the button lives in the unified header; the pick/entry
  // logic stays inside TradingChart (single source of truth — App mirrors the
  // armed flag for the label and the session/availability for visibility).
  const [replayPicking, setReplayPicking] = useState(false);
  const [replayUi, setReplayUi] = useState<{ active: boolean; canEnter: boolean }>({
    active: false,
    canEnter: false,
  });
  const handleReplayPickingChange = useCallback((picking: boolean) => {
    setReplayPicking(picking);
  }, []);
  const handleReplayStateChange = useCallback(
    (next: { active: boolean; canEnter: boolean }) => {
      setReplayUi((prev) =>
        prev.active === next.active && prev.canEnter === next.canEnter ? prev : next,
      );
    },
    [],
  );

  // Indicator Settings modal target — built on demand from the EXISTING
  // indicator state (no duplicate state). The chart legend's ⚙ opens it; the
  // modal edits a draft and commits via handleSettingsApply (Cancel discards).
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(null);

  // Realtime stream for the SELECTED timeframe (backend /ws relay). Switching
  // the selector drops the socket and re-subscribes with the new `res=` — the
  // backend re-seeds the forming candle for that timeframe automatically.
  // Independent of historical REST — realtime is the priority and always starts.
  const realtime = useRealtimeStream(timeframe, epic || undefined, streamEpoch);

  // Clock ticker so tick-age ("CONNECTED · NO TICKS") stays truthful.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Persist EMA configuration to localStorage on every change (guarded write).
  useEffect(() => {
    saveEmaSettings(emaSettings);
  }, [emaSettings]);

  // Persist SMA configuration to localStorage on every change (guarded write).
  useEffect(() => {
    saveSmaSettings(smaSettings);
  }, [smaSettings]);

  // Persist imported Pine indicators (source + settings) on every change.
  useEffect(() => {
    saveImportedPineIndicators(importedPine);
  }, [importedPine]);

  // Persist chart display settings (Invert Scale) on every change.
  useEffect(() => {
    saveChartSettings(chartSettings);
  }, [chartSettings]);

  // ── Shared chart-control actions ────────────────────────────────────────────
  // The chart's right-click context menu calls THESE — the old header "Auto" /
  // "Invert" buttons were removed, so the context menu is their single home.
  // One implementation per action, one state source, no duplicates.
  /** Invert Scale toggle: the single mutation of the persisted display
      setting; the chart context menu invokes it. */
  const toggleInvertScale = useCallback(() => {
    setChartSettings((prev) => ({ ...prev, invertScale: !prev.invertScale }));
  }, []);
  /** Auto (auto-follow) toggle: flips the `autoFollow` state consumed by the
      chart's ViewportBridge — the context menu invokes it. */
  const toggleAutoFollow = useCallback(() => setAutoFollow((prev) => !prev), []);

  // ── EMA Reversal Alerts ───────────────────────────────────────────────────
  // Initial config + state from the backend (the engine is the source of truth).
  useEffect(() => {
    let cancelled = false;
    void fetchEmaAlert()
      .then((r) => {
        if (cancelled) return;
        setEmaAlertSettings(r.settings);
        setEmaAlertState(r.state);
      })
      .catch(() => {
        /* engine unavailable — keep the defaults, UI shows "connecting" */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live engine state rides the existing /ws relay (server-side detection).
  useEffect(() => {
    if (realtime.emaAlert) setEmaAlertState(realtime.emaAlert);
  }, [realtime.emaAlert]);

  // Reflect the browser's push-subscription status.
  useEffect(() => {
    let cancelled = false;
    void currentSubscription().then((sub) => {
      if (!cancelled) setPushSubscribed(Boolean(sub));
    });
    return () => {
      cancelled = true;
    };
  }, [pushWorking]);

  /** Patch alert settings via REST — applied by the RUNNING backend (no restart). */
  const handleEmaAlertSettingsChange = useCallback((patch: Partial<EmaAlertSettings>) => {
    setEmaAlertSaving(true);
    setPushMessage(null);
    void saveEmaAlertSettings(patch)
      .then((r) => {
        setEmaAlertSettings(r.settings);
        setEmaAlertState(r.state);
      })
      .catch((err) => {
        setPushMessage(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setEmaAlertSaving(false));
  }, []);

  const handlePushEnable = useCallback(() => {
    if (pushAvail !== "supported") return;
    setPushWorking(true);
    setPushMessage(null);
    void enablePush()
      .then(async (r) => {
        setPushSubscribed(r.ok);
        setPushMessage(
          r.ok ? "Push enabled — phone notifications are live." : `Push unavailable: ${r.reason ?? "unknown error"}`,
        );
        if (r.ok) {
          try {
            const fresh = await fetchEmaAlert();
            setEmaAlertState(fresh.state);
          } catch {
            /* state refresh is best-effort */
          }
        }
      })
      .finally(() => setPushWorking(false));
  }, [pushAvail]);

  const handlePushDisable = useCallback(() => {
    setPushWorking(true);
    setPushMessage(null);
    void disablePush()
      .then((r) => {
        if (r.ok) setPushSubscribed(false);
        setPushMessage(r.ok ? "Push disabled." : `Could not disable push: ${r.reason ?? "unknown error"}`);
      })
      .finally(() => setPushWorking(false));
  }, []);

  const handleTestPush = useCallback(() => {
    setPushWorking(true);
    setPushMessage(null);
    void sendTestPush()
      .then((r) => {
        setPushMessage(
          r.ok ? "Test notification sent to your device." : `Test push failed: ${r.reason ?? "no device registered"}`,
        );
      })
      .catch((err) => setPushMessage(err instanceof Error ? err.message : String(err)))
      .finally(() => setPushWorking(false));
  }, []);

    /** Compile pipeline for the import modal — runs against the CURRENT chart candles. */
  const handlePineImport = useCallback(
    async (
      name: string,
      source: string,
      onStage?: (stage: PineCompileStage) => void,
    ): Promise<PineImportOutcome> => {
      if (importedPine.length >= MAX_IMPORTED_INDICATORS) {
        return {
          ok: false,
          issue: {
            kind: "limit",
            message: `At most ${MAX_IMPORTED_INDICATORS} imported indicators are supported. Remove one first.`,
          },
        };
      }
      const outcome = await compileImportedPine({
        name,
        source,
        bars: candles,
        liveCandle: realtime.candle,
        bucketSec: resolutionToBucketSec(timeframe),
        symbol: pineSymbol,
        onStage,
      });
      return outcome;
    },
    [candles, realtime.candle, timeframe, pineSymbol],
  );

  /**
   * Instrument switch — a CLEAN data/stream boundary (Phase 3): the previous
   * instrument's candles are dropped IMMEDIATELY (the chart never mixes DAX
   * and Gold bars); the realtime hook resets its stream and re-subscribes with
   * the new epic (frames are epic-filtered), and loadHistory re-runs for the
   * new instrument (its identity changes with `epic`).
   */
  const handleInstrumentChange = useCallback(
    (nextEpic: string) => {
      if (!nextEpic || nextEpic === epic) return;
      setCandles([]);
      selectInstrument(nextEpic);
    },
    [epic, selectInstrument],
  );

  /** Dynamic page title — the selected instrument (fallback: generic label). */
  useEffect(() => {
    document.title = `${selectedInstrument?.label ?? INSTRUMENT_LABEL} · AURA Chart`;
  }, [selectedInstrument?.label]);

  /** Confirm-import: called by the modal AFTER the user reviews the
   *  diagnostics panel (or immediately when nothing needs reviewing). */
  const handlePineImportConfirm = useCallback((indicator: ImportedPineIndicator) => {
    setImportedPine((prev) => {
      if (prev.length >= MAX_IMPORTED_INDICATORS) return prev;
      return [...prev, indicator];
    });
  }, []);

  /** Runtime status reporter — change-guarded so per-frame calls are cheap. */
  const handlePineStatus = useCallback((id: string, status: PineRunStatus) => {
    setPineStatuses((prev) => {
      const cur = prev[id];
      if (cur && cur.ok === status.ok && cur.message === status.message) return prev;
      return { ...prev, [id]: status };
    });
  }, []);

  /** Remove an imported indicator and drop its session status. */
  const handlePineChange = useCallback((next: ImportedPineIndicator[]) => {
    setImportedPine(next);
    setPineStatuses((prev) => {
      const ids = new Set(next.map((ind) => ind.id));
      const out: Record<string, PineRunStatus> = {};
      for (const [id, status] of Object.entries(prev)) {
        if (ids.has(id)) out[id] = status;
      }
      return out;
    });
  }, []);

  /** Open the Indicator Settings modal for one legend id (ema9/ema20/sma/Pine id). */
  const handleOpenIndicatorSettings = useCallback(
    (id: string) => {
      if (id === "ema9" || id === "ema20") {
        const cfg = emaSettings[id];
        setSettingsTarget({ kind: "ema", slotId: id, label: `EMA ${cfg.period}`, config: { ...cfg } });
        return;
      }
      if (id === "sma") {
        setSettingsTarget({ kind: "sma", label: `SMA ${smaSettings.period}`, config: { ...smaSettings } });
        return;
      }
      const ind = importedPine.find((x) => x.id === id);
      if (ind) {
        setSettingsTarget({ kind: "pine", id: ind.id, indicator: ind, status: pineStatuses[ind.id] ?? null });
      }
    },
    [emaSettings, smaSettings, importedPine, pineStatuses],
  );

  /** Commit the settings modal's draft into the existing state slices. */
  const handleSettingsApply = useCallback((next: SettingsApply) => {
    if (next.kind === "ema") {
      setEmaSettings((prev) => ({ ...prev, [next.slotId]: next.config }));
    } else if (next.kind === "sma") {
      setSmaSettings(next.config);
    } else {
      setImportedPine((prev) =>
        prev.map((x) => {
          if (x.id !== next.id) return x;
          const merged = { ...x, inputs: next.inputs };
          // Style tab — render-level overrides. Empty means "script styling":
          // drop the key entirely so a cleared Style tab truly resets.
          if (Object.keys(next.style).length > 0) merged.style = next.style;
          else delete (merged as Record<string, unknown>).style;
          return merged;
        }),
      );
    }
    setSettingsTarget(null);
  }, []);

  // Optional, non-blocking history load from OUR Supabase persistence
  // (GET /api/candles/db). If it fails (Supabase unconfigured / unreachable) we
  // keep streaming and just note it. IG historical REST is NOT used for normal
  // page history — its allowance errors can never block the chart from loading.
  //
  // Incremental pagination ("Load More History"): `historyStatus` tracks the
  // manual older-page fetches. The cursor is ALWAYS derived from the current
  // dataset's oldest candle (never stored globally), so an instrument or
  // timeframe switch can never reuse a foreign cursor — loadHistory resets the
  // status whenever the dataset changes.
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>(INITIAL_HISTORY_STATUS);
  const loadHistory = useCallback(async () => {
    const seq = ++requestSeq.current;
    const wantedEpic = epic; // switch guard: never accept candles for a superseded instrument
    setLoading(true);
    setHistoryStatus(INITIAL_HISTORY_STATUS); // new dataset → fresh pagination state
    try {
      const data = await fetchCandlesDb(timeframe, HISTORY_LIMIT, wantedEpic || undefined);
      if (seq !== requestSeq.current) return;
      if (wantedEpic && data.epic !== wantedEpic) return; // stale instrument — dropped
      // Invalidate any in-flight "Load More History" — its resolution would
      // merge onto the STALE (pre-scope-change) closure and could overwrite
      // this freshly-loaded dataset.
      moreHistorySeq.current++;
            setHistoryEpic(data.epic);
      setCandles(data.candles);
      setGaps(data.gaps);
      setHistoryMissing(false);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message;
      // HISTORY is optional — keep realtime streaming.
      setHistoryMissing(true);
      setGaps([]); // stale shading would outlive its dataset
      console.info(`[HISTORY] unavailable (realtime continues): ${msg}`);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [timeframe, epic]);

  // "Load More History": fetch the next OLDER page (cursor = oldest loaded
  // bucket) and prepend it. Guards (canLoadMore) keep exactly one request in
  // flight; the merge is strictly-older + dedupe, so live/newer candles are
  // never touched. Replay does not consume this path: while a replay session
  // is active TradingChart's data prop is a constant, so even a concurrent
  // merge could not repaint the replaying chart (and the control is hidden).
  const moreHistorySeq = useRef(0);
  const loadMoreHistory = useCallback(async () => {
    // Guards: one in-flight request max, nothing while exhausted, and always a
    // dataset to anchor the cursor to. `historyStatus`/`candles` are deps, so
    // the values here are current at click time (double-click = one request).
    if (!canLoadMore(historyStatus, candles.length > 0)) return;
    const cursor = cursorFrom(candles);
    if (cursor === null) return;
    const seq = ++moreHistorySeq.current;
    const wantedEpic = epic;
    const wantedTf = timeframe;
    setHistoryStatus((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await fetchCandlesDb(
        wantedTf,
        HISTORY_LIMIT,
        wantedEpic || undefined,
        Math.floor(cursor / 1000),
      );
      if (seq !== moreHistorySeq.current) return;
      if (wantedEpic && data.epic !== wantedEpic) return; // stale instrument — dropped
      const { merged, added } = mergeOlderCandles(candles, data.candles, cursor);
      setHistoryStatus({
        loading: false,
        exhausted: isExhausted(data.hasMore, added),
        error: null,
      });
      if (added > 0) {
        setCandles(merged);
        // Older pages carry their own derived gaps — merge (dedupe by exact
        // interval) so shading accumulates across the whole loaded window.
        setGaps((prev) => mergeGapLists(prev, data.gaps));
        console.info(`[HISTORY] +${added} older candles (oldest now ${iso(merged[0].ts)})`);
      }
    } catch (err) {
      if (seq !== moreHistorySeq.current) return;
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setHistoryStatus((prev) => ({ ...prev, loading: false, error: msg }));
      console.info(`[HISTORY] load-more failed (chart keeps current window): ${msg}`);
    }
  }, [epic, timeframe, candles, historyStatus]);

  // Initial load + page health.
  useEffect(() => {
    void loadHistory();
    void fetchHealth()
      .then((h) => setHealth({ configured: h.configured, environment: h.environment }))
      .catch(() => setHealth(null));
  }, [loadHistory]);

  // Background-tab re-sync. WS frames keep flowing while the tab is merely
  // hidden (they are merged correctly by LiveBarBridge even when rAF is
  // paused), but a suspended/sleeping device can miss BUCKETS entirely. On
  // return, if we were hidden longer than a candle, force a fresh WS
  // subscription (the backend re-seeds the forming candle for the selected
  // timeframe) and reload persisted history (the missed closed buckets) so the
  // chart reconciles without a manual refresh. No duplicate candles are
  // possible — bucket-ts guards discard/remerge frames.
  const RESYNC_AFTER_HIDDEN_MS = 60_000;
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (!hiddenAt) return;
      const awayMs = Date.now() - hiddenAt;
      hiddenAt = 0;
      if (awayMs < RESYNC_AFTER_HIDDEN_MS) return;
      console.info(
        `[APP] tab was hidden ${Math.round(awayMs / 1000)}s → re-syncing history + live stream`,
      );
      setStreamEpoch((x) => x + 1); // drops + reopens the socket → server re-seed
      void loadHistory();           // pulls any buckets missed while hidden
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [loadHistory]);

  // TEMPORARY safe diagnostics: [CHART TIME] on every history set.
  useEffect(() => {
    if (candles.length === 0) return;
    const now = Date.now();
    const first = candles[0];
    const last = candles[candles.length - 1];
    const live = realtime.candle ? realtime.candle.time * 1000 : null;
    console.info(
      `[CHART TIME] bars=${candles.length}` +
        ` history first=${iso(first.ts)}` +
        ` history last=${iso(last.ts)}` +
        ` live candle=${live ? iso(live) : "—"}` +
        ` now=${iso(now)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-identity">
          <div className="brand">
            <span className="dot" />
            <span className="brand-name">AURA</span>
            <span className="brand-sub">Chart</span>
          </div>
          <div className="instrument">
          {/* Instrument selector (Phase 3) — populated from the BACKEND
              registry (GET /api/instruments); switching is a clean data/stream
              boundary (see handleInstrumentChange). */}
          <select
            className="instrument-select"
            value={epic}
            onChange={(e) => handleInstrumentChange(e.target.value)}
            aria-label="Instrument"
            title="Switch instrument — stream, history and gaps follow the selection"
            disabled={!catalog}
          >
            {!catalog && <option value="">{INSTRUMENT_LABEL}</option>}
            {catalog?.instruments.map((inst) => (
              <option key={inst.epic} value={inst.epic}>
                {inst.label}
              </option>
            ))}
          </select>
            <span className="instrument-epic">{epic || historyEpic || "…"}</span>
          </div>
        </div>
        {/* Market group — timeframe · LIVE status · quote readout (timestamp,
            O H L C, change, Range) relocated from the removed bottom
            `.chart-footer` into the ONE unified header. */}
        <div className="topbar-market" aria-label="Market data">
          {/* Timeframe selector — 1m (canonical persisted) | 3m (derived) */}
          <div className="timeframes" role="tablist" aria-label="Chart timeframe">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.key}
                role="tab"
                aria-selected={timeframe === tf.key}
                className={`tf-btn ${timeframe === tf.key ? "active" : ""}`}
                title={`${tf.label} timeframe (${tf.bucketSec}s buckets)`}
                onClick={() => setTimeframe(tf.key)}
              >
                {tf.label}
              </button>
            ))}
          </div>
          {(() => {
            const sl = streamLabel(realtime.status, realtime.lastTickAt, nowTick);
            const cls = sl.live ? "live" : sl.noTicks ? "noticks" : realtime.status.toLowerCase();
            const ageTxt =
              sl.ageSec !== null ? ` · last tick ${sl.ageSec}s ago` : " · no ticks received yet";
            return (
              <span
                className={`stream-chip ${cls}`}
                title={`IG Lightstreamer: ${realtime.status}${ageTxt} · ${realtime.ticks} ticks this session · ${epic || historyEpic || "—"}`}
              >
                <span className="dot" />
                {sl.label}
              </span>
            );
          })()}
          {/* Quote strip — values come from the CHART (crosshair hover ??
              replay cursor ?? latest bar) via onQuoteCandle; no duplicated state. */}
          <OHLCReadout candle={quoteCandle} invertScale={chartSettings.invertScale} />
        </div>
        <div className="topbar-actions">
          {/* Replay entry — a first-class chart control in the unified header.
              Hidden while a session is active (the in-plot dock takes over);
              disabled while there is nothing to replay. */}
          {!replayUi.active && (
            <button
              type="button"
              className={`ck-replay-btn topbar-replay-btn${replayPicking ? " picking" : ""}`}
              onClick={() => handleReplayPickingChange(!replayPicking)}
              disabled={!replayUi.canEnter}
              title={
                replayPicking
                  ? "Click a candle on the chart to start Replay from it"
                  : "Replay history bar-by-bar — click a candle to choose the start"
              }
            >
              {replayPicking ? "Click a candle to start Replay…" : "Replay"}
            </button>
          )}
          <div className="toolbar-group toolbar-group--analysis" aria-label="Chart analysis">
            {/* ƒx Indicators — ADD/IMPORT only (Pine Script import flow).
                Management/configuration lives in the chart legend + the
                Indicator Settings modal. */}
            <IndicatorsMenu
              importedCount={importedPine.length}
              onCompile={handlePineImport}
              onImportConfirm={handlePineImportConfirm}
            />
          </div>
          <div className="toolbar-group toolbar-group--status" aria-label="Connection status">
            {/* EMA Reversal Alerts — server-side detection; this control only
                configures (REST) + displays state streamed over /ws. */}
            <EmaAlertControl
            state={emaAlertState}
            settings={emaAlertSettings}
            timeframe={timeframe}
            saving={emaAlertSaving}
            pushAvailability={pushAvail}
            pushSubscribed={pushSubscribed}
            pushWorking={pushWorking}
            pushMessage={pushMessage}
            onSettingsChange={handleEmaAlertSettingsChange}
            onPushEnable={handlePushEnable}
              onPushDisable={handlePushDisable}
              onTestPush={handleTestPush}
            />
          </div>
          <div className="toolbar-group toolbar-group--actions" aria-label="Chart controls">
          <button
            className="refresh-btn"
            onClick={() => {
              setStreamEpoch((x) => x + 1);
              void loadHistory();
            }}
            disabled={loading}
          >
              {loading ? "…" : "Refresh"}
            </button>
          </div>
        </div>
      </header>

      {!health?.configured && (
        <div className="banner warn">
          Backend isn’t configured yet — set IG credentials in <code>backend/.env</code> and restart.
        </div>
      )}
      {historyMissing && !loading && (
        <div className="banner warn">
          <span className="banner-text">HISTORY: persisted candles unavailable (Supabase) — realtime stream continues.</span>
        </div>
      )}

      <main className="chart-area">
                <TradingChart
          candles={candles}
          gaps={gaps}
          resolution={timeframe}
          liveCandle={realtime.candle}
          streamStatus={realtime.status}
          loading={loading}
          autoFollow={autoFollow}
          emaSettings={emaSettings}
          smaSettings={smaSettings}
          pineIndicators={importedPine}
          pineSymbol={pineSymbol}
          onPineStatus={handlePineStatus}
          invertScale={chartSettings.invertScale}
          onToggleInvertScale={toggleInvertScale}
          onToggleAutoFollow={toggleAutoFollow}
          replaySymbol={selectedEpic || undefined}
          onLoadMoreHistory={loadMoreHistory}
          historyStatus={historyStatus}
          onQuoteCandle={handleQuoteCandle}
          replayPicking={replayPicking}
          onReplayPickingChange={handleReplayPickingChange}
          onReplayStateChange={handleReplayStateChange}
          onEmaChange={setEmaSettings}
          onSmaChange={setSmaSettings}
          onPineChange={handlePineChange}
          onOpenIndicatorSettings={handleOpenIndicatorSettings}
        />
      </main>

      {/* Indicator Settings (⚙ from the chart legend) — keyed so switching
          indicators remounts with a fresh draft of THAT indicator's config. */}
      {settingsTarget && (
        <IndicatorSettingsModal
          key={
            settingsTarget.kind === "ema"
              ? `ema:${settingsTarget.slotId}`
              : settingsTarget.kind === "sma"
                ? "sma"
                : `pine:${settingsTarget.id}`
          }
          target={settingsTarget}
          onApply={handleSettingsApply}
          onCancel={() => setSettingsTarget(null)}
        />
      )}
    </div>
  );
}
