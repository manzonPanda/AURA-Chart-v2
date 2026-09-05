/**
 * AURA Chart — realtime candlestick chart with a 1m / 3m timeframe selector.
 * Priority: realtime stream (Lightstreamer → WS → chart) even if historical
 * REST is unavailable (e.g. IG_ALLOWANCE_EXHAUSTED).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { TradingChart } from "./components/TradingChart/TradingChart";
import { IndicatorsMenu } from "./components/Indicators/IndicatorsMenu";
import {
  DEFAULT_TIME_FRAME,
  HISTORY_LIMIT,
  INSTRUMENT_LABEL,
  TIMEFRAMES,
  type TimeFrameKey,
} from "./config/chart";
import { loadEmaSettings, saveEmaSettings, type EmaSettings } from "./config/emaSettings";
import {
  loadChartSettings,
  saveChartSettings,
  type ChartSettings,
} from "./config/chartSettings";
import { ApiError, fetchCandlesDb, fetchHealth } from "./services/api";
import { useInstruments } from "./services/useInstruments";
import {
  compileImportedPine,
  loadImportedPineIndicators,
  MAX_IMPORTED_INDICATORS,
  saveImportedPineIndicators,
  type ImportedPineIndicator,
  type PineImportOutcome,
  type PineRunStatus,
} from "./services/pineImport";
import { useRealtimeStream, resolutionToBucketSec } from "./services/realtime";
import { iso } from "./services/diagnostics";
import type { Candle } from "./types/candle";
import { EmaAlertControl } from "./components/EmaAlert/EmaAlertControl";
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
  // Instrument selection (Phase 3) — the BACKEND REGISTRY (GET /api/instruments)
  // is the source of truth; localStorage only persists WHICH entry is active.
  // selectedEpic is "" until the catalog resolves → WS/history then run WITHOUT
  // an epic param → the backend serves its default (DAX): the historic behavior.
  const { catalog, selectedEpic, selected: selectedInstrument, selectInstrument } = useInstruments();
  const epic = selectedEpic;
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
  // Imported Pine indicators — script source + settings ONLY (localStorage,
  // versioned `aura.pine.indicators`). Values are always recomputed by the
  // PineTS engine against the selected timeframe's candles.
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

  // Persist imported Pine indicators (source + settings) on every change.
  useEffect(() => {
    saveImportedPineIndicators(importedPine);
  }, [importedPine]);

  // Persist chart display settings (Invert Scale) on every change.
  useEffect(() => {
    saveChartSettings(chartSettings);
  }, [chartSettings]);

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
    async (name: string, source: string): Promise<PineImportOutcome> => {
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
      });
      return outcome;
    },
    [candles, realtime.candle, timeframe],
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

  // Optional, non-blocking history load from OUR Supabase persistence
  // (GET /api/candles/db). If it fails (Supabase unconfigured / unreachable) we
  // keep streaming and just note it. IG historical REST is NOT used for normal
  // page history — its allowance errors can never block the chart from loading.
  const loadHistory = useCallback(async () => {
    const seq = ++requestSeq.current;
    const wantedEpic = epic; // switch guard: never accept candles for a superseded instrument
    setLoading(true);
    try {
      const data = await fetchCandlesDb(timeframe, HISTORY_LIMIT, wantedEpic || undefined);
      if (seq !== requestSeq.current) return;
      if (wantedEpic && data.epic !== wantedEpic) return; // stale instrument — dropped
      setHistoryEpic(data.epic);
      setCandles(data.candles);
      setHistoryMissing(false);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message;
      // HISTORY is optional — keep realtime streaming.
      setHistoryMissing(true);
      console.info(`[HISTORY] unavailable (realtime continues): ${msg}`);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [timeframe, epic]);

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
        <div className="topbar-actions">
          {/* EMA indicator slots (9/20) + Imported Pine Script section —
              localStorage-persisted config */}
          <IndicatorsMenu
            settings={emaSettings}
            onChange={setEmaSettings}
            imported={importedPine}
            pineStatuses={pineStatuses}
            onImportedChange={handlePineChange}
            onCompile={handlePineImport}
            onImportConfirm={handlePineImportConfirm}
          />
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
          <label className="auto-toggle" title="Auto-follow the latest candle; turn off to pan freely">
            <input
              type="checkbox"
              checked={autoFollow}
              onChange={(e) => setAutoFollow(e.target.checked)}
            />
            Auto
          </label>
          {/* Invert Scale — visual-only price-scale inversion (TradingView-style).
              Native LWC `invertScale` on the main right scale via
              InvertScaleBridge (TradingChart). Pure viewport transform —
              candle data, crosshair values and the time axis are untouched. */}
          <button
            type="button"
            className={`invert-toggle ${chartSettings.invertScale ? "on" : ""}`}
            aria-pressed={chartSettings.invertScale}
            title={
              chartSettings.invertScale
                ? "Inverted: higher prices appear lower and bull/bear candle colors are swapped (click to restore)"
                : "Click to invert the price scale — higher prices will appear lower and candle colors will swap"
            }
            onClick={() =>
              setChartSettings((prev) => ({ ...prev, invertScale: !prev.invertScale }))
            }
          >
            Invert Scale: {chartSettings.invertScale ? "ON" : "OFF"}
          </button>
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
          resolution={timeframe}
          liveCandle={realtime.candle}
          streamStatus={realtime.status}
          loading={loading}
          autoFollow={autoFollow}
          emaSettings={emaSettings}
          pineIndicators={importedPine}
          onPineStatus={handlePineStatus}
          invertScale={chartSettings.invertScale}
          replaySymbol={selectedEpic || undefined}
        />
      </main>

      <footer className="statusbar">
        <span>Environment: {health?.environment ?? "…"}</span>
        <span>Bars: {candles.length > 0 ? candles.length : realtime.candle ? 1 : 0}</span>
        <span>Stream ticks: {realtime.ticks}</span>
        {realtime.lastTickAt > 0 && (
          <span>Last tick: {Math.max(0, Math.round((nowTick - realtime.lastTickAt) / 1000))}s ago</span>
        )}
      </footer>
    </div>
  );
}