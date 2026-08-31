import type { Candle } from "../../types/candle";
import { formatManilaDateTimeFull } from "../../services/timefmt";

interface Props {
  candle?: Candle;
}

const fmtPrice = (v: number | undefined): string =>
  v == null || Number.isNaN(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Compact OHLC/quote strip fed by the most recent candle. */
export function OHLCReadout({ candle }: Props) {
  const last = candle;
  const change = last ? last.close - last.open : 0;
  const range = last ? last.high - last.low : 0;
  const up = change >= 0;

  return (
    <div className="ohlc" aria-label="OHLC">
      {last && (
        <span className="ohlc-item time" title="Bucket start — Asia/Manila (UTC+08:00)">
          {formatManilaDateTimeFull(last.ts)}
        </span>
      )}
      <span className="ohlc-item o">
        O&nbsp;{fmtPrice(last?.open)}
      </span>
      <span className="ohlc-item h">
        H&nbsp;{fmtPrice(last?.high)}
      </span>
      <span className="ohlc-item l">
        L&nbsp;{fmtPrice(last?.low)}
      </span>
      <span className="ohlc-item c">
        C&nbsp;{fmtPrice(last?.close)}
      </span>
      {last && (
        <>
          <span className={`ohlc-item chg ${up ? "up" : "down"}`}>
            {up ? "+" : ""}{fmtPrice(change)}
          </span>
          <span className={`ohlc-item chg-pct ${up ? "up" : "down"}`}>
            {up ? "+" : ""}
            {last.open !== 0 ? ((change / last.open) * 100).toFixed(2) : "0.00"}%
          </span>
        </>
      )}
      <span className="ohlc-item range">
        Range {fmtPrice(range)}
      </span>
    </div>
  );
}