/**
 * EMA Alert toolbar control — bell button + settings popover.
 *
 * Visual states of the button:
 *   off      muted              alerts disabled
 *   on       accent             alerts enabled, idle
 *   pending  amber + "n/N"      a reversal is awaiting confirmation
 *   confirmed (last alert)      surfaces in the popover status line
 *
 * All detection is server-side; this control only reflects state, edits
 * settings (POST /api/ema-alert/settings — applied live, no restart) and
 * manages the browser's push subscription. No arrow glyphs are used in any
 * user-facing text (per feature spec) — relationships render as
 * "EMA 9 > EMA 20" / "EMA 9 < EMA 20".
 */
import { useEffect, useRef, useState } from "react";
import type { EmaAlertSettings, EmaAlertState, EmaAlertUnitState } from "../../services/emaAlertApi";
import { sessionDisplay } from "../../services/sessionTimes";
import type { PushAvailability } from "../../services/pushClient";
import { EmaAlertPopover, emaAlertStatusText } from "./EmaAlertPopover";

interface Props {
  state: EmaAlertState | null;
  settings: EmaAlertSettings | null;
  /** Currently selected chart timeframe — used to pick which unit state to show. */
  timeframe: string;
  saving: boolean;
  pushAvailability: PushAvailability;
  pushSubscribed: boolean;
  pushWorking: boolean;
  pushMessage: string | null;
  onSettingsChange: (patch: Partial<EmaAlertSettings>) => void;
  onPushEnable: () => void;
  onPushDisable: () => void;
  onTestPush: () => void;
}

export function EmaAlertControl({
  state,
  settings,
  timeframe,
  saving,
  pushAvailability,
  pushSubscribed,
  pushWorking,
  pushMessage,
  onSettingsChange,
  onPushEnable,
  onPushDisable,
  onTestPush,
}: Props) {
  const [open, setOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Popover close on outside click / Escape (same behavior as IndicatorsMenu).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 30 s ticker so the session-open flag and PH-time labels stay truthful.
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const unitState: EmaAlertUnitState | null = state?.states?.[timeframe] ?? null;
  const enabled = settings?.enabled ?? state?.enabled ?? false;
  const timeframeEnabled = settings?.alertTimeframes?.includes(timeframe as "MINUTE_1" | "MINUTE_3") ?? false;
  const pending = unitState?.pending ?? null;
  const buttonClass = `ema-alert-btn ${enabled && timeframeEnabled ? (pending ? "pending" : "on") : "off"}`;
  const session = sessionDisplay(clock, settings?.sessionStart ?? "09:30", settings?.sessionEnd ?? "16:00");

  return (
    <div className="ema-alert" ref={rootRef}>
      <button
        type="button"
        className={buttonClass}
        title={emaAlertStatusText(unitState)}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ema-bell" aria-hidden>
          🔔
        </span>
        EMA Alert
        {pending && (
          <span className="ema-badge">
            {pending.confirmations}/{pending.needed}
          </span>
        )}
      </button>
      {open && (
        <EmaAlertPopover
          state={state}
          settings={settings}
          timeframe={timeframe}
          unitState={unitState}
          saving={saving}
          session={session}
          pushAvailability={pushAvailability}
          pushSubscribed={pushSubscribed}
          pushWorking={pushWorking}
          pushMessage={pushMessage}
          onSettingsChange={onSettingsChange}
          onPushEnable={onPushEnable}
          onPushDisable={onPushDisable}
          onTestPush={onTestPush}
        />
      )}
    </div>
  );
}
