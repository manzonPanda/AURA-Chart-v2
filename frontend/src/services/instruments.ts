/**
 * Instrument selection (Phase 3) — the BACKEND REGISTRY (GET /api/instruments)
 * is the single source of truth; this module never hardcodes EPICs. The
 * browser only persists WHICH registry entry the user picked (localStorage).
 *
 * Pure helpers (selection resolution, persistence, catalog lookup) are
 * framework-free and unit-tested in tests/instruments.test.mjs; the
 * useInstruments() hook wires them to React.
 */
import { API_BASE, ApiError } from "./api.ts";
export interface InstrumentCalendarInfo {
  id: string;
  label: string;
  timezone: string;
}

export interface InstrumentInfo {
  epic: string;
  label: string;
  /** Quoting precision of the instrument (DAX 1, Spot Gold 2). */
  decimals: number;
  calendar: InstrumentCalendarInfo | null;
}

export interface InstrumentsCatalog {
  defaultEpic: string;
  count: number;
  instruments: InstrumentInfo[];
}

/** localStorage key for the user's instrument choice (the EPIC itself). */
export const INSTRUMENT_STORAGE_KEY = "aura.instrument.epic";

/** Read the persisted selection (null when absent/unavailable). */
export function loadSelectedEpic(storage: { getItem(key: string): string | null } = window.localStorage): string | null {
  try {
    return storage.getItem(INSTRUMENT_STORAGE_KEY);
  } catch {
    return null; // private-mode / disabled storage — default applies
  }
}

/** Persist the selection (guarded write — storage failures never break the UI). */
export function saveSelectedEpic(epic: string, storage: { setItem(key: string, value: string): void } = window.localStorage): void {
  try {
    storage.setItem(INSTRUMENT_STORAGE_KEY, epic);
  } catch {
    /* storage unavailable — selection stays session-only */
  }
}

/**
 * Resolve the active EPIC: the persisted choice WINS only while the registry
 * still contains it (e.g. IG_GOLD_EPIC removed → falls back to the default).
 * No stored pick → the registry default (DAX). Nothing configured → "".
 */
export function resolveSelectedEpic(
  epics: readonly string[],
  defaultEpic: string,
  stored: string | null,
): string {
  const list = epics.filter(Boolean);
  if (stored && list.includes(stored)) return stored;
  if (defaultEpic && list.includes(defaultEpic)) return defaultEpic;
  return list[0] ?? "";
}

/** Catalog lookup for the active EPIC (null when not yet resolved). */
export function findInstrument(catalog: InstrumentsCatalog | null, epic: string): InstrumentInfo | null {
  return catalog?.instruments.find((i) => i.epic === epic) ?? null;
}

/** GET /api/instruments — the configured instrument registry (backend truth). */
export async function fetchInstruments(): Promise<InstrumentsCatalog> {
  const res = await fetch(`${API_BASE}/instruments`);
  if (!res.ok) {
    let message = res.statusText || "Request failed";
    let code = "HTTP_ERROR";
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      if (body?.code) code = body.code;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }
  const body = (await res.json()) as Partial<InstrumentsCatalog>;
  if (!body || typeof body.defaultEpic !== "string" || !Array.isArray(body.instruments)) {
    throw new ApiError(res.status, "INVALID_INSTRUMENTS", "GET /api/instruments returned an unexpected payload.");
  }
  return body as InstrumentsCatalog;
}