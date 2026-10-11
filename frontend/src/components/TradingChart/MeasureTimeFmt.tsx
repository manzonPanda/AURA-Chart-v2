import { useEffect, useRef, type ReactNode } from "react";
import { timeTokenToHM } from "../../services/measureTimeFmt";

/**
 * Wraps CandleKit's MeasurementOverlay and reformats its time token to AURA's
 * unit style — each part spelled out only when it has a value
 * ("90m" → "1h 30m", "2.0h" → "2h", "45m" → "45m").
 *
 * The library keeps owning EVERYTHING the tooltip shows — values, box, skin,
 * flip/clamp positioning; this wrapper performs a single, scoped presentation
 * pass: it watches the subtree it wraps and mutates the DATA of the last text
 * node inside `.ck-measure-meta` (the fmtTime() output). The node itself is
 * never replaced — it is the node React created, so the library's subsequent
 * updates land on the same node and the observer simply reformats them again
 * (no detached-node / stale-render hazards).
 *
 * The wrapper is a plain static div: it never becomes a positioning context,
 * so the overlay's absolute `.ck-measure-layer` still resolves against
 * ChartView exactly as before. The % row is hidden separately by theming
 * (`.measure-time-fmt .ck-measure-pct` in styles.css) — AURA's tooltip shows
 * pts, bars, and the unit-style time, nothing else.
 */
export function MeasureTimeFmt({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reformat = (): void => {
      const meta = host.querySelector(".ck-measure-meta");
      if (!meta) return;
      const last = meta.childNodes[meta.childNodes.length - 1];
      // The time token is always the library's LAST child of `.ck-measure-meta`
      // (barCount · time). Mutate that node's data in place.
      if (!last || last.nodeType !== Node.TEXT_NODE) return;
      const text = last as CharacterData;
      const hm = timeTokenToHM(text.data);
      // null = not a native token (already "1h 30m", cleared, or future
      // wording) — leave the library's text untouched and let it surface as-is.
      if (hm && hm !== text.data) text.data = hm;
    };
    const obs = new MutationObserver(reformat);
    // childList: the readout mounts/clears with each drag; characterData: the
    // library updates the time mid-drag (our own write re-fires this too —
    // timeTokenToHM then returns null or the identical string, both of which
    // terminate the loop; the property test in measureTimeFmt.test.mjs pins
    // that guarantee).
    obs.observe(host, { childList: true, subtree: true, characterData: true });
    reformat();
    return () => obs.disconnect();
  }, []);

  return (
    <div className="measure-time-fmt" ref={hostRef}>
      {children}
    </div>
  );
}
