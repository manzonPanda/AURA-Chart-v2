/**
 * Instrument registry — the seam that generalizes AURA beyond DAX.
 *
 * Phase 0 scope (this file): DATA ONLY. No streaming/API/frontend behavior
 * changes — every consumer keeps its current single-EPIC wiring. Phase 1+
 * consumers (multi-stream realtime, API validation, GET /api/instruments, the
 * frontend selector) read from here, so adding an instrument = one registry
 * entry + one env var, never a pipeline change.
 *
 * Identity rule (DB): the `instrument` column of public.ohlc_candles stores
 * the RAW IG EPIC — existing DAX rows are `IX.D.DAX.IGM.IP` and Gold writes
 * `CS.D.CFIGOLD.CFI.IP`. No symbolic ids, no data migration, and the
 * `(instrument, timeframe, bucket_time)` uniqueness constraint already
 * separates the two instruments.
 *
 * Price precision: the live stream must round each instrument's MID onto its
 * own quoting grid (DAX = 1 decimal; Spot Gold = 2 — its SGD quotes carry
 * cents, e.g. bid 4467.47). An UNREGISTERED EPIC falls back to 1 decimal,
 * which is byte-exact the historic behavior for any pre-registry config.
 */
import { IG_GERMANY_40, IG_SPOT_GOLD, type MarketCalendar } from "./calendar.js";
import type { Config } from "../config.js";

export interface InstrumentMeta {
  /** Raw IG EPIC — also the ohlc_candles.instrument identity. */
  epic: string;
  /** Human label for the UI + push notifications ("DAX / IG"). */
  label: string;
  /** Decimal places the instrument quotes at (its rounding grid). */
  decimals: number;
  /**
   * Market calendar for gap detection / backfill planning. `null` ONLY for
   * unregistered EPICs — never guess another market's hours.
   */
  calendar: MarketCalendar | null;
}

/** Germany 40 Cash (E1) — verified against the account (1-decimal quoting). */
export const DAX_INSTRUMENT: InstrumentMeta = {
  epic: "IX.D.DAX.IGM.IP",
  label: "DAX / IG",
  decimals: 1,
  calendar: IG_GERMANY_40,
};

/** Spot Gold (SGD1 Contract) — verified against the account (SGD, 2-decimal). */
export const GOLD_INSTRUMENT: InstrumentMeta = {
  epic: "CS.D.CFIGOLD.CFI.IP",
  label: "Spot Gold / IG",
  decimals: 2,
  calendar: IG_SPOT_GOLD,
};

const REGISTRY: ReadonlyMap<string, InstrumentMeta> = new Map([
  [DAX_INSTRUMENT.epic, DAX_INSTRUMENT],
  [GOLD_INSTRUMENT.epic, GOLD_INSTRUMENT],
]);

/** Metadata for any EPIC — unregistered ones get BC-conservative defaults. */
export function instrumentMetaFor(epic: string): InstrumentMeta {
  const key = epic.trim();
  const hit = REGISTRY.get(key);
  if (hit) return hit;
  return { epic: key, label: key || "(unset)", decimals: 1, calendar: null };
}

/** Market calendar for an EPIC — null ONLY for unregistered EPICs (gap
 *  detection must never guess another market's dealing hours). */
export function calendarForInstrument(epic: string): MarketCalendar | null {
  return instrumentMetaFor(epic).calendar;
}

/**
 * Instruments this deployment configures, in canonical order (DAX first =
 * the default instrument; Gold second). DAX comes from IG_DAX_EPIC (kept for
 * BC — its value remains the DB identity), Gold from IG_GOLD_EPIC. Duplicate
 * EPICs collapse so a misconfiguration can never double-persist one market.
 */
export function configuredInstruments(config: Config): InstrumentMeta[] {
  const out: InstrumentMeta[] = [];
  const seen = new Set<string>();
  for (const epic of [config.ig.defaultEpic, config.ig.goldEpic]) {
    const key = epic.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(instrumentMetaFor(key));
  }
  return out;
}

/** Round a raw price onto an instrument's quoting grid (Math.round parity). */
export function roundToInstrumentPrecision(raw: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(raw * factor) / factor;
}
