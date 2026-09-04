/**
 * EMA Alert settings popover + shared text helpers.
 *
 * Self-contained so `EmaAlertControl` can import its status helpers with a
 * single dependency direction (Control → Popover, no cycle).
 */
import type { ConfirmationCandles, EmaAlertSettings, EmaAlertState, EmaAlertTimeframe, EmaAlertUnitState } from "../../services/emaAlertApi";
import type { SessionDisplay } from "../../services/sessionTimes";
import type { PushAvailability } from "../../services/pushClient";

export const CONFIRMATION_CHOICES: readonly ConfirmationCandles[] = [1, 2, 3, 4, 5];

/** Human status line (mirrors the spec's chart-feedback wording). */
export function emaAlertStatusText(unit: EmaAlertUnitState | null): string {
  if (!unit) return "connecting to alert engine";
  if (unit.pending) {
    const dir = unit.pending.direction === "bullish" ? "bullish" : "bearish";
    return `EMA ${dir} confirmation ${unit.pending.confirmations}/${unit.pending.needed}`;
  }
  const last = unit.lastAlert;
  if (last && Date.now() - last.atMs < 5 * 60_000) {
    return `EMA ${last.direction} reversal confirmed`;
  }
  if (!unit.enabled) return "EMA alerts off for this timeframe";
  if (unit.relationship === "bull") return "EMA 9 > EMA 20";
  if (unit.relationship === "bear") return "EMA 9 < EMA 20";
  return unit.ready ? "EMA alerts on" : "warming up EMAs";
}

/** Settings popover — configuration, session info, push management, status. */
export function EmaAlertPopover(props: {
  state: EmaAlertState | null;
  settings: EmaAlertSettings | null;
  timeframe: string;
  unitState: EmaAlertUnitState | null;
  saving: boolean;
  session: SessionDisplay;
  pushAvailability: PushAvailability;
  pushSubscribed: boolean;
  pushWorking: boolean;
  pushMessage: string | null;
  onSettingsChange: (patch: Partial<EmaAlertSettings>) => void;
  onPushEnable: () => void;
  onPushDisable: () => void;
  onTestPush: () => void;
}) {
  const { state, settings, timeframe, unitState, saving, session, pushAvailability, pushSubscribed, pushWorking, pushMessage } = props;
    const tf = timeframe as "MINUTE_1" | "MINUTE_3";
  const timeframeLabel: Record<"MINUTE_1" | "MINUTE_3", string> = { MINUTE_1: "1m", MINUTE_3: "3m" };
  const toggleTimeframe = (tf: "MINUTE_1" | "MINUTE_3", checked: boolean): void => {
    const cur: string[] = settings?.alertTimeframes ?? [];
        const next: string[] = checked
      ? Array.from(new Set([...cur, tf]))
      : cur.filter((t) => t !== tf);
    props.onSettingsChange({ alertTimeframes: next as EmaAlertTimeframe[] });
  };
  return (
    <div className="ema-alert-pop" role="dialog" aria-label="EMA Alert settings">
      <label className="ema-row ema-master">
        <input
          type="checkbox"
          checked={settings?.enabled ?? false}
          disabled={saving || !settings}
          onChange={(e) => props.onSettingsChange({ enabled: e.target.checked })}
        />
        <span>Enable EMA reversal alerts</span>
      </label>

      <label className="ema-row">
        <span>Timeframes</span>
        <div className="ema-dir">
          <label>
            <input
              type="checkbox"
              checked={settings?.alertTimeframes?.includes("MINUTE_1") ?? false}
              disabled={saving || !settings}
                            onChange={(e) => toggleTimeframe("MINUTE_1", e.target.checked)}
            />
            1m
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings?.alertTimeframes?.includes("MINUTE_3") ?? false}
              disabled={saving || !settings}
                            onChange={(e) => toggleTimeframe("MINUTE_3", e.target.checked)}
            />
            3m
          </label>
        </div>
      </label>

      <div className={`ema-status ${unitState?.pending ? "pending" : ""}`}>{emaAlertStatusText(unitState)}</div>
      <div className="ema-note">Listening on: {timeframeLabel[tf] ?? timeframe}</div>
      {state && state.enabled && !state.sessionOpenNow && (
        <div className="ema-note">Outside the New York session — no notifications are generated.</div>
      )}

      <label className="ema-row">
        <span>Confirmation candles</span>
        <select
          value={settings?.confirmationCandles ?? 2}
          disabled={saving || !settings}
          onChange={(e) =>
            props.onSettingsChange({ confirmationCandles: Number(e.target.value) as ConfirmationCandles })
          }
        >
          {CONFIRMATION_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <div className="ema-row ema-dir">
        <label>
          <input
            type="checkbox"
            checked={settings?.bullishEnabled ?? true}
            disabled={saving || !settings}
            onChange={(e) => props.onSettingsChange({ bullishEnabled: e.target.checked })}
          />
          Bullish
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings?.bearishEnabled ?? true}
            disabled={saving || !settings}
            onChange={(e) => props.onSettingsChange({ bearishEnabled: e.target.checked })}
          />
          Bearish
        </label>
      </div>

      <label className="ema-row">
        <span>Cooldown (min)</span>
        <input
          type="number"
          min={0}
          max={720}
          value={settings?.cooldownMinutes ?? 30}
          disabled={saving || !settings}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(n)) {
              props.onSettingsChange({ cooldownMinutes: Math.min(720, Math.max(0, Math.round(n))) });
            }
          }}
        />
      </label>

      <div className="ema-session">
        <div className="ema-session-title">Session — New York cash equities</div>
        <div className="ema-session-line">
          {session.nyStart}–{session.nyEnd} New York
        </div>
        <div className="ema-session-ph">
          {session.phStart}–{session.phEnd} Manila
        </div>
        <div className={session.openNow ? "ema-open" : "ema-closed"}>{session.openNow ? "Session open" : "Session closed"}</div>
      </div>

      <div className="ema-push">
        <div className="ema-session-title">Phone notifications (Web Push)</div>
        {pushAvailability !== "supported" ? (
          <div className="ema-note">
            {pushAvailability === "insecure-context"
              ? "Push needs HTTPS — enable TLS (certbot) on the VM, or use localhost."
              : "This browser does not support Web Push."}
          </div>
        ) : state && !state.pushConfigured ? (
          <div className="ema-note">Server push is not configured — set VAPID_* in backend/.env.</div>
        ) : (
          <div className="ema-actions">
            {!pushSubscribed ? (
              <button type="button" className="ema-btn" disabled={pushWorking} onClick={props.onPushEnable}>
                Enable push
              </button>
            ) : (
              <button type="button" className="ema-btn" disabled={pushWorking} onClick={props.onPushDisable}>
                Disable push
              </button>
            )}
            <button type="button" className="ema-btn" disabled={pushWorking} onClick={props.onTestPush}>
              Send test
            </button>
          </div>
        )}
        {pushMessage && <div className="ema-note">{pushMessage}</div>}
        {state && state.pushConfigured && (
          <div className="ema-note">
            {state.pushSubscriptions} device{state.pushSubscriptions === 1 ? "" : "s"} registered
          </div>
        )}
      </div>

            <div className="ema-footnote">
        Detection runs on the backend over closed candles of the selected timeframe — the forming candle never triggers an alert. Alerts are not linked to the currently open chart; they fire for every configured timeframe independently.
      </div>
    </div>
  );
}
