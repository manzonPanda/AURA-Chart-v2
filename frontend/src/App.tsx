import { useCallback, useEffect, useRef, useState } from "react";
import { TradingChart } from "./components/TradingChart/TradingChart";
import { CANDLE_LIMIT, DEFAULT_TIMEFRAME_KEY, TIMEFRAMES } from "./config/timeframes";
import { ApiError, fetchCandles, fetchHealth } from "./services/api";
import type { Candle } from "./types/candle";

const AUTO_REFRESH_MS = 30_000;

export default function App() {
  const [key, setKey] = useState(DEFAULT_TIMEFRAME_KEY);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [resolution, setResolution] = useState<string>("");
  const [epic, setEpic] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [health, setHealth] = useState<{ configured: boolean; environment: string } | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(
    async (timeframeKey: string) => {
      const tf = TIMEFRAMES.find((t) => t.key === timeframeKey) ?? TIMEFRAMES[0];
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const data = await fetchCandles(tf.resolution, CANDLE_LIMIT);
        if (seq !== requestSeq.current) return; // a newer request superseded this one
        setEpic(data.epic);
        setResolution(data.resolution);
        setCandles(data.candles);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
        setCandles([]);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [],
  );

  // Initial load + page health.
  useEffect(() => {
    void load(key);
    void fetchHealth()
      .then((h) => setHealth({ configured: h.configured, environment: h.environment }))
      .catch(() => setHealth(null));
  }, [key, load]);

  // Optional polling so new candles/EMA updates flow in without manual action.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => void load(key), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, key, load]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <span className="brand-name">AURA</span>
          <span className="brand-sub">Chart</span>
        </div>
        <div className="instrument">
          <span className="instrument-name">DAX / IG</span>
          <span className="instrument-epic">{epic || "…"}</span>
        </div>

        <div className="timeframes" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              className={`tf-btn${tf.key === key ? " active" : ""}`}
              onClick={() => {
                setKey(tf.key);
                setCandles([]); // clear stale data while the new timeframe loads
              }}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <div className="topbar-actions">
          <span className="meta-chip">{resolution || "—"}</span>
          <label className="auto-toggle" title="Auto-refresh candles every 30s">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto
          </label>
          <button className="refresh-btn" onClick={() => void load(key)} disabled={loading}>
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error">
          <span className="banner-text">{error}</span>
          <button className="banner-close" onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {!error && !loading && candles.length === 0 && health && !health.configured && (
        <div className="banner warn">
          Backend isn't configured yet — set IG credentials in <code>backend/.env</code> and restart.
        </div>
      )}

      <main className="chart-area">
        <TradingChart candles={candles} loading={loading} />
      </main>

      <footer className="statusbar">
        <span>Environment: {health?.environment ?? "…"}</span>
        <span>Bars loaded: {candles.length}</span>
        <span>EMA 20 · EMA 50</span>
      </footer>
    </div>
  );
}