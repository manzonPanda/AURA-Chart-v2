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
import { IG_GERMANY_40, IG_SPOT_GOLD, IG_SPOT_SILVER, type MarketCalendar } from "./calendar.js";
import { isCapitalConfigured, type Config } from "../config.js";

export interface InstrumentMeta {
  /** Instrument identity — also the ohlc_candles.instrument column value.
      DAX = the raw IG EPIC; Capital Gold = "GOLD" (the user-confirmed
      migration identity, NOT an IG epic). No symbolic ids, no migrations. */
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
  /** Which market-data provider serves this instrument's stream/history.
      "IG" = legacy Lightstreamer + IG REST; "CAPITAL" = Capital.com WS + REST.
      Determines the stream client + historical source RealtimeService uses. */
  provider: "IG" | "CAPITAL";
}

/** Germany 40 Cash (E1) — verified against the account (1-decimal quoting). */
export const DAX_INSTRUMENT: InstrumentMeta = {
  epic: "IX.D.DAX.IGM.IP",
  label: "DAX / IG",
  decimals: 1,
  calendar: IG_GERMANY_40,
  provider: "IG",
};

/**
 * Spot Gold — the CAPITAL.com provider identity (user-confirmed migration
 * decision 2026-09): epic "GOLD" (Capital's spot Gold CFD symbol, NOT GOLDUS/
 * GOLDAU/GCZ2026/futures), same CME Globex dealing-hours calendar as the
 * legacy IG entry, 2-decimal SGD quoting. This is the identity AURA now
 * streams, backfills and persists under.
 */
export const GOLD_INSTRUMENT: InstrumentMeta = {
  epic: "GOLD",
  label: "Spot Gold / Capital.com",
  decimals: 2,
  calendar: IG_SPOT_GOLD,
  provider: "CAPITAL",
};

/**
 * Legacy IG Spot Gold identity (CS.D.CFIGOLD.CFI.IP) — RETAINED ONLY so the
 * existing ohlc_candles rows under the old epic stay REGISTERED (rounding grid
 * + calendar resolve identically) until the post-validation cleanup phase.
 * Never collected/streamed again: it is NOT in configuredInstruments once
 * Capital credentials are present, and the live pipeline writes only "GOLD".
 */
export const LEGACY_GOLD_INSTRUMENT: InstrumentMeta = {
  epic: "CS.D.CFIGOLD.CFI.IP",
  label: "Spot Gold / IG (legacy)",
  decimals: 2,
  calendar: IG_SPOT_GOLD,
  provider: "IG",
};

/** Spot Silver ($1) — verified against the account (2-decimal, same CME Globex hours as Gold). */
export const SILVER_INSTRUMENT: InstrumentMeta = {
  epic: "CS.D.CFDSILVER.CMG.IP",
  label: "Spot Silver / IG",
  decimals: 2,
  calendar: IG_SPOT_SILVER,
  provider: "IG",
};

const REGISTRY: ReadonlyMap<string, InstrumentMeta> = new Map([
  [DAX_INSTRUMENT.epic, DAX_INSTRUMENT],
  [GOLD_INSTRUMENT.epic, GOLD_INSTRUMENT],
  [LEGACY_GOLD_INSTRUMENT.epic, LEGACY_GOLD_INSTRUMENT],
  [SILVER_INSTRUMENT.epic, SILVER_INSTRUMENT],
]);

/** Metadata for any EPIC — unregistered ones get BC-conservative defaults. */
export function instrumentMetaFor(epic: string): InstrumentMeta {
  const key = epic.trim();
  const hit = REGISTRY.get(key);
  if (hit) return hit;
  return { epic: key, label: key || "(unset)", decimals: 1, calendar: null, provider: "IG" };
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
/**
 * Collection set — the instruments actually streamed/persisted. Driven by the
 * configured EPICs; an empty epic means "not collected" (BC).
 *
 * Provider-aware (Capital migration): when Capital.com credentials are present,
 * Gold's slot resolves to the CAPITAL provider identity ("GOLD") and the legacy
 * IG Gold epic (CS.D.CFIGOLD.CFI.IP) is NOT collected — legacy rows stay in
 * Supabase untouched but no new IG Gold rows are written. Without Capital
 * credentials the exact historic set is returned (DAX + IG Gold + IG Silver).
 */
export function configuredInstruments(config: Config): InstrumentMeta[] {
  const out: InstrumentMeta[] = [];
  const seen = new Set<string>();
  const push = (meta: InstrumentMeta | null): void => {
    // Empty-epic guard (restored from HEAD): an unset config epic resolves to
    // a fallback meta with epic "" — it means "not collected", never a real
    // instrument. Skipping it keeps the historic list shapes byte-exact.
    if (!meta || !meta.epic || seen.has(meta.epic)) return;
    seen.add(meta.epic);
    out.push(meta);
  };
  // DAX — legacy IG provider (unchanged).
  push(instrumentMetaFor(config.ig.defaultEpic.trim()));
  if (isCapitalConfigured(config)) {
    // Gold — CAPITAL provider identity ("GOLD") when Capital creds exist.
    push(GOLD_INSTRUMENT);
  } else {
    // Gold — legacy IG epic (pre-migration behavior).
    push(instrumentMetaFor(config.ig.goldEpic.trim()));
  }
  // Silver — legacy IG provider (unchanged).
  push(instrumentMetaFor(config.ig.silverEpic.trim()));
  return out;
}

/**
 * UI/HISTORICAL instruments — the catalog served by GET /api/instruments and
 * the epic allowlist of /api/candles/db (Supabase history reads). This is
 * deliberately WIDER than the collection set: the built-in DAX constant is
 * ALWAYS included so historical DAX rows stay queryable and viewable in the
 * chart UI even when IG_DAX_EPIC is empty (DAX collection disabled). Gold is
 * the CAPITAL identity when Capital creds are configured, else legacy IG Gold.
 * Silver comes from config — DAX history viewing is a built-in guarantee,
 * not a configuration. The legacy IG Gold epic is intentionally NOT in the
 * UI list post-migration (its rows remain registered/queryable by epic but are
 * superseded by the Capital dataset for the chart).
 */
export function uiInstruments(config: Config): InstrumentMeta[] {
  const out: InstrumentMeta[] = [DAX_INSTRUMENT];
  const seen = new Set<string>([DAX_INSTRUMENT.epic]);
  const push = (meta: InstrumentMeta | null): void => {
    // Same empty-epic guard as configuredInstruments (see above).
    if (!meta || !meta.epic || seen.has(meta.epic)) return;
    seen.add(meta.epic);
    out.push(meta);
  };
  if (isCapitalConfigured(config)) {
    push(GOLD_INSTRUMENT);
  } else {
    push(instrumentMetaFor(config.ig.goldEpic.trim()));
  }
  push(instrumentMetaFor(config.ig.silverEpic.trim()));
  return out;
}

/** Round a raw price onto an instrument's quoting grid (Math.round parity). */
export function roundToInstrumentPrecision(raw: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(raw * factor) / factor;
}
