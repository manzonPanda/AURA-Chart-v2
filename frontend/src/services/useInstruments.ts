/**
 * useInstruments (Phase 3) — React binding for the instrument registry.
 *
 * Kept separate from the pure helpers in services/instruments.ts so the test
 * runner can exercise those helpers without importing React (Node's CJS
 * interop cannot destructure named exports from React's build).
 *
 * The BACKEND REGISTRY (GET /api/instruments) is the source of truth;
 * localStorage persists only WHICH registry entry the user picked.
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchInstruments,
  findInstrument,
  loadSelectedEpic,
  resolveSelectedEpic,
  saveSelectedEpic,
  type InstrumentInfo,
  type InstrumentsCatalog,
} from "./instruments";

export interface UseInstrumentsResult {
  catalog: InstrumentsCatalog | null;
  loading: boolean;
  error: string | null;
  /** The active EPIC — "" until the catalog resolves (backend then defaults
   *  to DAX for both WS and history, the historic behavior). */
  selectedEpic: string;
  /** Full metadata of the active instrument (null pre-resolution). */
  selected: InstrumentInfo | null;
  /** Persist + activate an instrument (the caller clears chart state). */
  selectInstrument: (epic: string) => void;
}

export function useInstruments(): UseInstrumentsResult {
  const [catalog, setCatalog] = useState<InstrumentsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEpic, setSelectedEpic] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchInstruments()
      .then((cat) => {
        if (cancelled) return;
        setCatalog(cat);
        setSelectedEpic(
          resolveSelectedEpic(
            cat.instruments.map((i) => i.epic),
            cat.defaultEpic,
            loadSelectedEpic(),
          ),
        );
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectInstrument = useCallback((epic: string) => {
    setSelectedEpic((prev) => {
      if (!epic || prev === epic) return prev;
      saveSelectedEpic(epic);
      return epic;
    });
  }, []);

  return {
    catalog,
    loading,
    error,
    selectedEpic,
    selected: findInstrument(catalog, selectedEpic),
    selectInstrument,
  };
}