/**
 * AURA Chart — realtime candlestick chart with a 1m / 3m timeframe selector.
 * Priority: realtime stream (Lightstreamer → WS → chart) even if historical
 * REST is unavailable (e.g. IG_ALLOWANCE_EXHAUSTED).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { TradingChart } from "./components/TradingChart/TradingChart";
import {
  DEFAULT_TIME_FRAME,
  HISTORY_LIMIT,
  INSTRUMENT_LABEL,
  TIMEFRAMES,
  type TimeFrameKey,
} from "./config/chart";
import { ApiError, fetchCandlesDb, fetchHealth } from "./services/api";
import { useRealtimeStream } from "./services/realtime";
import { iso } from "./services/diagnostics";
import type { Candle } from "./types/candle";

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
  const [epic, setEpic] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true); // TradingView-style follow
  const [historyMissing, setHistoryMissing] = useState(false);
  const [health, setHealth] = useState<{ configured: boolean; environment: string } | null>(null);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [timeframe, setTimeframe] = useState<TimeFrameKey>(DEFAULT_TIME_FRAME);
  const requestSeq = useRef(0);

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

  // Optional, non-blocking history load from OUR Supabase persistence
  // (GET /api/candles/db). If it fails (Supabase unconfigured / unreachable) we
  // keep streaming and just note it. IG historical REST is NOT used for normal
  // page history — its allowance errors can never block the chart from loading.
  const loadHistory = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const data = await fetchCandlesDb(timeframe, HISTORY_LIMIT);
      if (seq !== requestSeq.current) return;
      setEpic(data.epic);
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
  }, [timeframe]);

  // Initial load + page health.
  useEffect(() => {
    void loadHistory();
    void fetchHealth()
      .then((h) => setHealth({ configured: h.configured, environment: h.environment }))
      .catch(() => setHealth(null));
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
          <span className="instrument-name">{INSTRUMENT_LABEL}</span>
          <span className="instrument-epic">{epic || "…"}</span>
        </div>
        <div className="topbar-actions">
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
                title={`IG Lightstreamer: ${realtime.status}${ageTxt} · ${realtime.ticks} ticks this session · ${epic || "—"}`}
              >
                <span className="dot" />
                {sl.label}
              </span>
            );
          })()}
          <label className="auto-toggle" title="Auto-follow the latest candle; turn off to pan freely">
            <input
              type="checkbox"
              checked={autoFollow}
              onChange={(e) => setAutoFollow(e.target.checked)}
            />
            Auto
          </label>
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