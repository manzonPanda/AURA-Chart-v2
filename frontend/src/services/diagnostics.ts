/**
 * TEMPORARY safe diagnostics for the historical + realtime candle pipeline.
 *
 * Counts frames/updates end-to-end and emits throttled console blocks so the
 * browser console proves the full path (WS frames → updateBar → visible bars)
 * without flooding at tick rate. No secrets ever pass through here — only
 * timestamps, counts and prices.
 */

export const diag = {
  /** WebSocket frames received from the backend relay. */
  wsFramesReceived: 0,
  /** Of which `{type:"candle"}` frames. */
  wsCandleFrames: 0,
  /** Of which `{type:"status"}` frames. */
  wsStatusFrames: 0,
  /** Candle frames the chart applied via controller.updateBar(). */
  updateBarCalls: 0,
  /** Candle frames discarded as out-of-order (ts older than the last bar). */
  updateBarSkipped: 0,
  /** Times the chart seeded an empty series with the first live candle. */
  dataSeeded: 0,
};

export const iso = (epochMs: number): string => new Date(epochMs).toISOString();

/** [WS] candle-frame log — at most one line per bucket + ≥5 s apart. */
let lastCandleLogAt = 0;
let lastCandleBucket = 0;
export function logWsCandleFrame(timeframe: string, timeSec: number, close: number): void {
  const now = Date.now();
  if (timeSec !== lastCandleBucket || now - lastCandleLogAt >= 5_000) {
    lastCandleBucket = timeSec;
    lastCandleLogAt = now;
    console.info(
      `[WS] candle frame #${diag.wsCandleFrames} timeframe=${timeframe} bucketStart=${iso(timeSec * 1000)} close=${close}`,
    );
  }
}

/** [CHART] summary block — throttled to one line per 15 s. */
let lastChartBlockAt = 0;
export function maybeLogChartBlock(
  barsCount: number,
  lastHistoricalTs: number | null,
  currentLiveTs: number | null,
): void {
  const now = Date.now();
  if (now - lastChartBlockAt < 15_000) return;
  lastChartBlockAt = now;
  console.info(
    `[CHART] bars=${barsCount}` +
      ` lastHistorical=${lastHistoricalTs ? iso(lastHistoricalTs) : "—"}` +
      ` currentLive=${currentLiveTs ? iso(currentLiveTs) : "—"}` +
      ` updateBarCalls=${diag.updateBarCalls}` +
      ` skipped=${diag.updateBarSkipped}` +
      ` wsFrames=${diag.wsFramesReceived}(candle=${diag.wsCandleFrames})`,
  );
}

/** [CHART] updateBar — throttled to one line per 5 s so the live update path is
 *  visible without flooding at tick rate. */
let lastUpdateBarLogAt = 0;
export function logUpdateBar(timeSec: number, close: number): void {
  const now = Date.now();
  if (now - lastUpdateBarLogAt < 5_000) return;
  lastUpdateBarLogAt = now;
  console.info(`[CHART] updateBar #${diag.updateBarCalls} bucket=${iso(timeSec * 1000)} close=${close}`);
}
