/**
 * Instrument registry — the single source of truth for instrument metadata.
 *
 * Provider model (IG retired 2026): the ACTIVE collection set
 * (configuredInstruments) contains ONLY CAPITAL-provider instruments — today
 * that is exactly [GOLD]. DAX and the legacy IG Gold/Silver identities remain
 * in the registry as LEGACY-ARCHIVE metadata so historical rows stay
 * queryable/registered (rounding grid + calendar resolve identically); they
 * are deliberately NEVER part of the collection set and cannot become active
 * (RealtimeService also refuses any non-CAPITAL provider at stream time).
 *
 * Adding a future instrument (e.g. SILVER → CAPITAL) = one registry entry + a
 * Capital-market verification — never a pipeline change.
 *
 * Identity rule (DB): the `instrument` column of public.ohlc_candles stores
 * the raw symbol/EPIC — GOLD = "GOLD" (Capital), archive rows keep their
 * historic identities (DAX = `IX.D.DAX.IGM.IP`, legacy gold =
 * `CS.D.CFIGOLD.CFI.IP`, silver = `CS.D.CFDSILVER.CMG.IP`). No symbolic ids,
 * no data migration, and the `(instrument, timeframe, bucket_time)`
 * uniqueness constraint already separates the instruments.
 *
 * Price precision: the live stream rounds each instrument's MID onto its own
 * quoting grid (Spot Gold = 2). An UNREGISTERED EPIC falls back to 1 decimal.
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

/** Germany 40 (E1) — LEGACY ARCHIVE metadata (historic IG identity, 1-decimal
 *  quoting). DAX is never collected any more (IG retired); the entry only keeps
 *  historical rows registered/queryable. */
export const DAX_INSTRUMENT: InstrumentMeta = {
  epic: "IX.D.DAX.IGM.IP",
  label: "DAX / IG (legacy archive)",
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

/**
 * Spot Silver — LEGACY ARCHIVE metadata only (historic IG identity
 * CS.D.CFDSILVER.CMG.IP, verified against the account). Silver is NOT
 * collected (it is not in the collection set), and it is NOT configured as
 * Capital because the Capital.com silver identity has not been selected/
 * verified yet. Adding SILVER → CAPITAL later = verify the Capital symbol,
 * add a registry entry, push it in configuredInstruments — no pipeline change.
 */
export const SILVER_INSTRUMENT: InstrumentMeta = {
  epic: "CS.D.CFDSILVER.CMG.IP",
  label: "Spot Silver / IG (legacy archive)",
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

/** Metadata for any EPIC — unregistered ones get BC-conservative defaults.
 *  The fallback `provider` is the legacy "IG" label ONLY as a safe default:
 *  unregistered epics are never part of the collection set, and the realtime
 *  service refuses every non-CAPITAL provider, so this can never come alive. */
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
 * COLLECTION SET — the instruments actually streamed + persisted. Since IG is
 * retired this is EXACTLY the configured CAPITAL-provider instruments (today
 * ["GOLD"] when Capital credentials exist). Duplicate EPICs collapse so a
 * misconfiguration can never double-persist one market.
 *
 * Deliberately NO IG fallback: without Capital credentials the set is EMPTY
 * (nothing collected) — a legacy/IG provider entry can never become active
 * here, and an unavailable Capital provider never degrades to another feed.
 */
export function configuredInstruments(config: Config): InstrumentMeta[] {
  if (!isCapitalConfigured(config)) return [];
  return [GOLD_INSTRUMENT];
}

/**
 * UI/HISTORICAL catalog — served by GET /api/instruments and the epic
 * allowlist of /api/candles/db (archive history reads). Deliberately WIDER
 * than the collection set: DAX + Silver are LEGACY ARCHIVE entries (their
 * historical rows — Supabase/archive — stay queryable and viewable in the
 * chart UI) while GOLD is the active CAPITAL instrument. Archive entries are
 * NEVER collected; they exist purely so the legacy archive remains readable.
 * The legacy IG Gold epic is intentionally NOT in the UI list post-migration
 * (its rows remain registered/queryable by epic but are superseded by the
 * Capital dataset for the chart).
 */
export function uiInstruments(config: Config): InstrumentMeta[] {
  const out: InstrumentMeta[] = [DAX_INSTRUMENT];
  const seen = new Set<string>([DAX_INSTRUMENT.epic]);
  const push = (meta: InstrumentMeta | null): void => {
    if (!meta || !meta.epic || seen.has(meta.epic)) return;
    seen.add(meta.epic);
    out.push(meta);
  };
  push(isCapitalConfigured(config) ? GOLD_INSTRUMENT : LEGACY_GOLD_INSTRUMENT);
  // Silver — legacy archive entry (NEVER collected; its Capital identity is
  // not yet selected/verified, so it is deliberately not configured as Capital).
  push(SILVER_INSTRUMENT);
  return out;
}

/** Round a raw price onto an instrument's quoting grid (Math.round parity). */
export function roundToInstrumentPrecision(raw: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(raw * factor) / factor;
}
