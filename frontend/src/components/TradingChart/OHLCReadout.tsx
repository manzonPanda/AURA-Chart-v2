import type { Candle } from "../../types/candle";
import { formatManilaDayHHMM } from "../../services/timefmt";
import { effectiveBullish } from "./candleColors";

interface Props {
  /** The quote candle — null before any candle exists (header renders "—"). */
  candle?: Candle | null;
  /** AURA inverted semantics — the rendered direction swaps when true. */
  invertScale?: boolean;
}

const fmtPrice = (v: number | undefined): string =>
  v == null || Number.isNaN(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Compact OHLC quote strip rendered in App's unified header. Values are the
 * real market numbers; the CLOSE is tinted by the rendered direction
 * (effectiveBullish — swaps under Invert Scale) so the strip still reads
 * bull/bear at a glance without separate change/range chips.
 */
export function OHLCReadout({ candle, invertScale = false }: Props) {
  const last = candle;
  // Rendered direction follows AURA's inverted semantics so the close tint
  // matches the on-screen (possibly color-swapped) candle. The VALUES are
  // always the real market numbers.
  const up = last ? effectiveBullish(last.close, last.open, invertScale) : false;

  return (
    <div className="ohlc" aria-label="OHLC">
      {last && (
        <span className="ohlc-item time" title="Bucket start — Asia/Manila (UTC+08:00)">
          {formatManilaDayHHMM(last.ts)}
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
      <span className={`ohlc-item c${last ? (up ? " up" : " down") : ""}`}>
        C&nbsp;{fmtPrice(last?.close)}
      </span>
    </div>
  );
}