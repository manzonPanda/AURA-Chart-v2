/**
 * EMA Reversal Alert engine — server-side orchestrator, TIMEFRAME-AWARE.
 *
 *   ClosedCandle rollovers (MINUTE_1 AND MINUTE_3 — RealtimeService)
 *     → per-timeframe PineEmaSeries (PineTS ta.ema 9/20 on CLOSED candles)
 *       → per-timeframe EmaAlertPipeline (NY session + confirmation + cooldown)
 *         → PushService (Web Push) + WS broadcast (UI state)
 *
 * HARD RULES:
 *   - Each configured timeframe is an INDEPENDENT unit with its own EMA
 *     series, state machine, pending reversal, cooldown timestamps and last
 *     processed candle. A 1m signal can never interfere with 3m (and vice
 *     versa).
 *   - EMA math is PineTS only, ONE PineEmaSeries instance per timeframe.
 *     3m EMA is computed from 3m CLOSED candles — never by transforming the
 *     1m EMA values. No second EMA implementation.
 *   - The forming/live candle NEVER reaches any detector (engine is fed
 *     exclusively from closed-candle rollovers; per-unit bucket guards add
 *     defense in depth).
 *   - Notification generation is configured by `alertTimeframes` and runs
 *     server-side regardless of any browser connection or the timeframe a
 *     chart happens to be viewing.
 */
import type { CandleStore } from "../db/candleStore.js";
import { isClosedCandleInSession } from "./nySession.js";
import type { ReversalDirection } from "./reversalDetector.js";
import { PineEmaSeries, type EmaCandle } from "./pineEma.js";
import { EmaAlertPipeline, type AlertClock, type ClosedSignal, type PendingInfo } from "./alertPipeline.js";
import type { PushService, PushSubscriptionShape } from "./pushService.js";
import type { EmaAlertSettingsStore } from "./settingsStore.js";
import { sanitizeEmaAlertSettings, type EmaAlertSettings, type EmaAlertTimeframe } from "./emaAlertConfig.js";
import { STREAM_TIME_FRAMES, TIMEFRAME_BUCKET_SEC } from "../streaming/timeframes.js";
import { aggregateCompleteToMinutes } from "../streaming/timeframes.js";
import type { Candle } from "../types/candle.js";

/** Warm-up window: ~1200 1m candles ≈ 20 h — plenty for EMA 20 convergence. */
const WARMUP_CANDLES = 1200;
/** Cap on each per-timeframe in-memory closed-candle series. */
const MAX_SERIES_CANDLES = 1300;

/** The closed-candle subset the engine consumes (epoch-second bucket start). */
export interface ClosedCandleInput {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Close instant of a closed candle whose bucket STARTS at `bucketSec`, derived
 * from the TIMEFRAME's bucket width (MINUTE_1 = +60 s, MINUTE_3 = +180 s) —
 * never a hardcoded 1m assumption. Used consistently for live processing,
 * warm-up, session evaluation and replay/re-derivation.
 */
export function closeMsOf(timeframe: string, bucketSec: number): number {
  const bucketSecWidth = TIMEFRAME_BUCKET_SEC[timeframe] ?? 60;
  return (bucketSec + bucketSecWidth) * 1000;
}

/** Per-timeframe display/notification label ("1m" / "3m"). */
export function timeframeUnitLabel(timeframe: string): string {
  const minutes = (TIMEFRAME_BUCKET_SEC[timeframe] ?? 60) / 60;
  return `${minutes}m`;
}

/** Per-timeframe alert state (one entry per configured timeframe). */
export interface EmaAlertUnitState {
  timeframe: string;
  /** Global master enabled AND this timeframe in alertTimeframes. */
  enabled: boolean;
  relationship: "bull" | "bear" | "flat" | null;
  pending: PendingInfo | null;
  lastAlert: { direction: ReversalDirection; price: number; atMs: number; bucketSec: number } | null;
  lastEma9: number | null;
  lastEma20: number | null;
  closedCandles: number;
  ready: boolean;
}

/** Whole-engine snapshot broadcast over /ws and served via REST. */
export interface EmaAlertState {
  enabled: boolean;
  alertTimeframes: string[];
  sessionOpenNow: boolean;
  pushConfigured: boolean;
  pushSubscriptions: number;
  states: Record<string, EmaAlertUnitState>;
}

export interface EmaAlertEngineDeps {
  epic: string;
  /** Human instrument label for notification content (e.g. "DAX / IG"). */
  instrumentLabel: string;
  candleStore: CandleStore | null;
  push: PushService;
  store: EmaAlertSettingsStore;
  /** Injectable clock for deterministic cooldown tests (defaults to Date.now). */
  clock?: AlertClock;
  /** Fan an auxiliary WS frame to every connected browser. */
  broadcast: (msg: Record<string, unknown>) => void;
}

/** One independent timeframe unit: EMA series + reversal state machine. */
interface TimeframeUnit {
  timeframe: string;
  bucketSec: number;
  series: PineEmaSeries;
  pipeline: EmaAlertPipeline;
  lastEma9: number | null;
  lastEma20: number | null;
    lastAlert: EmaAlertUnitState["lastAlert"];
}

export class EmaAlertEngine {
  private settings: EmaAlertSettings;
  private readonly units = new Map<string, TimeframeUnit>();
  private warmupDone = false;
  private readonly queue: Array<{ candle: ClosedCandleInput; timeframe: string }> = [];
  private processing = Promise.resolve();
  private lastBroadcastKey = "";

  constructor(private readonly deps: EmaAlertEngineDeps) {
    const loaded = deps.store.load();
    this.settings = loaded.settings;
    for (const timeframe of STREAM_TIME_FRAMES) {
      const bucketSec = TIMEFRAME_BUCKET_SEC[timeframe];
      const pipeline = new EmaAlertPipeline(() => this.unitSettings(timeframe), deps.clock);
      pipeline.setLastAlertAt({
        bullish: loaded.runtime.lastAlertBullishAt[timeframe] ?? 0,
        bearish: loaded.runtime.lastAlertBearishAt[timeframe] ?? 0,
      });
      this.units.set(timeframe, {
        timeframe,
        bucketSec,
        series: new PineEmaSeries(),
        pipeline,
        lastEma9: null,
        lastEma20: null,
        lastAlert: this.lastAlertFromRuntime(timeframe, loaded.runtime),
      });
    }
  }

  /** Per-unit enabled view: master switch AND timeframe selection gate. */
    private unitSettings(timeframe: string): EmaAlertSettings {
    return {
      ...this.settings,
      enabled: this.settings.enabled && this.settings.alertTimeframes.includes(timeframe as EmaAlertTimeframe),
    };
  }

  /** Restore the most recent alert of `timeframe` from persisted cooldown state. */
  private lastAlertFromRuntime(
    timeframe: string,
    runtime: { lastAlertBullishAt: Record<string, number>; lastAlertBearishAt: Record<string, number> },
  ): EmaAlertUnitState["lastAlert"] {
    const latestBull = runtime.lastAlertBullishAt[timeframe] ?? 0;
    const latestBear = runtime.lastAlertBearishAt[timeframe] ?? 0;
    if (latestBull === 0 && latestBear === 0) return null;
    if (latestBull >= latestBear) {
      return { direction: "bullish" as const, price: NaN, atMs: latestBull, bucketSec: 0 };
    }
    return { direction: "bearish" as const, price: NaN, atMs: latestBear, bucketSec: 0 };
  }

  /** Load persisted state, warm up EACH timeframe unit, then go live. */
  async start(): Promise<void> {
    if (this.deps.candleStore) {
      try {
        const rows = await this.deps.candleStore.loadCandles(this.deps.epic, "MINUTE_1", WARMUP_CANDLES);
        // MINUTE_1 unit: persisted 1m candles directly.
        const oneMinCandles: EmaCandle[] = rows.map((r) => ({
          openTime: r.time * 1000,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          closeTime: r.time * 1000 + 60_000,
          volume: 0,
        }));
        await this.warmupUnit("MINUTE_1", oneMinCandles);

        // MINUTE_3 unit: derive COMPLETE 3m candles from persisted 1m rows
        // using the EXACT existing aggregateCompleteToMinutes grid+rules — the
        // same derivation the 3m history endpoint and live overlay use, so
        // warm-up candle sets are byte-compatible with live 3m closes.
        const oneMin: Candle[] = rows.map((r) => ({
          ts: r.time * 1000,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
        }));
        const threeMin = aggregateCompleteToMinutes(oneMin, 3);
        const threeMinCandles: EmaCandle[] = threeMin.map((c) => ({
          openTime: c.ts,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          closeTime: c.ts + 180_000,
          volume: 0,
        }));
        await this.warmupUnit("MINUTE_3", threeMinCandles);
      } catch (err) {
        console.log(
          `[EMA ALERT] warm-up unavailable (detection starts once candles close live): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Drain anything that closed while warming up (deduped by bucket guard).
    // warmupDone stays FALSE during the drain so concurrent live frames keep
    // queuing instead of racing the shared PineTS runtimes.
    const queued = this.queue.splice(0);
    for (const q of queued) await this.processClosedCandle(q.candle, q.timeframe);
    this.warmupDone = true;
    this.broadcast(true);
  }

  getSettings(): EmaAlertSettings {
    return { ...this.settings };
  }

  /** Apply a settings patch to the RUNNING engine (no restart) and persist. */
  async applySettings(patch: unknown): Promise<EmaAlertSettings> {
    const next = sanitizeEmaAlertSettings({ ...this.settings, ...(patch as Record<string, unknown>) });
    this.settings = next;
    // Re-derive lifecycle state for every ENABLED unit against the new
    // configuration (alerts are never re-emitted during a replay). Disabled
    // units keep tracking quietly; re-enabling replays + resumes correctly.
    for (const unit of this.units.values()) {
            if (!next.alertTimeframes.includes(unit.timeframe as EmaAlertTimeframe)) continue;
      unit.pipeline.reconfigure(await this.signalsFromUnit(unit), (bucketSec) => closeMsOf(unit.timeframe, bucketSec));
      await this.updateLastEma(unit);
    }
    this.persistState();
    this.broadcast(true);
    return this.getSettings();
  }

  /** Closed-candle entry point (RealtimeService rollover — ANY timeframe). */
  onClosedCandle(candle: ClosedCandleInput, timeframe: string): void {
    if (!this.units.has(timeframe)) return;
    if (!this.warmupDone) {
      this.queue.push({ candle, timeframe });
      return;
    }
    // Serialize processing across ALL units: one closed candle at a time,
    // routed to its own series + pipeline (never concurrent on one PineTS runtime).
    this.processing = this.processing
      .then(() => this.processClosedCandle(candle, timeframe))
      .catch(() => {
        /* processClosedCandle is guarded internally and never rejects */
      });
  }

  /** Await any in-flight closed-candle processing (test/drain helper). */
    async flush(): Promise<void> {
    await this.processing;
  }

  /** Per-timeframe status snapshot for the REST endpoint / WS broadcast. */
  statusSnapshot(): EmaAlertState {
    const states: Record<string, EmaAlertUnitState> = {};
    for (const [timeframe, unit] of this.units) {
      states[timeframe] = {
        timeframe,
                enabled: this.settings.enabled && this.settings.alertTimeframes.includes(timeframe as EmaAlertTimeframe),
        relationship: relationshipOf(unit.lastEma9, unit.lastEma20),
        pending: unit.pipeline.state().pending
          ? {
              direction: unit.pipeline.state().pending!.direction,
              confirmations: unit.pipeline.state().pending!.confirmations,
              needed: this.settings.confirmationCandles,
            }
          : null,
        lastAlert: unit.lastAlert,
        lastEma9: unit.lastEma9,
        lastEma20: unit.lastEma20,
        closedCandles: unit.series.length,
        ready: this.warmupDone && unit.lastEma9 !== null && unit.lastEma20 !== null,
      };
    }
    return {
      enabled: this.settings.enabled,
      alertTimeframes: [...this.settings.alertTimeframes],
      sessionOpenNow: isClosedCandleInSession(Date.now(), this.settings.sessionStart, this.settings.sessionEnd),
      pushConfigured: this.deps.push.configured,
      pushSubscriptions: this.deps.push.count(),
      states,
    };
  }

  /** Public VAPID key for the browser subscription flow (null when unset). */
  vapidPublicKey(): string | null {
    return this.deps.push.publicKey();
  }

  /** Store a browser push subscription (managed via REST). */
  subscribePush(subscription: PushSubscriptionShape): void {
    this.deps.push.add(subscription);
    this.broadcast(true);
  }

  /** Remove a browser push subscription by endpoint. */
  unsubscribePush(endpoint: string): void {
    this.deps.push.remove(endpoint);
    this.broadcast(true);
  }

  /** One harmless test notification — lets the user verify the phone path. */
  async sendTestNotification(): Promise<{ ok: boolean; sent: number; reason?: string }> {
    if (!this.deps.push.configured) {
      return { ok: false, sent: 0, reason: "Push is not configured on the server (set VAPID_* in backend/.env)." };
    }
    const result = await this.deps.push.sendAll({
      title: "AURA test notification",
      body: "EMA Reversal Alerts are wired up. Real alerts arrive only after full confirmation.",
      direction: "test",
    });
    return { ok: result.sent > 0, sent: result.sent, ...(result.sent === 0 ? { reason: "No subscriptions registered yet." } : {}) };
    }
  // ── internals ──
  /** Warm up ONE timeframe unit: load series, re-derive state, no alerts. */
  private async warmupUnit(timeframe: string, candles: EmaCandle[]): Promise<void> {
    const unit = this.units.get(timeframe);
    if (!unit || candles.length === 0) return;
    unit.series.setCandles(candles);
    const signals = await this.signalsFromUnit(unit);
    if (signals.length > 0) {
      unit.pipeline.replay(signals, (bucketSec) => closeMsOf(timeframe, bucketSec));
    }
    await this.updateLastEma(unit);
    console.log(`[EMA ALERT] warm-up complete: ${timeframe} → ${candles.length} closed candles, state rebuilt`);
  }

  /** Build closed-candle signals for a unit's WHOLE retained series (replays). */
  private async signalsFromUnit(unit: TimeframeUnit): Promise<ClosedSignal[]> {
    const values9 = await unit.series.compute(9);
    const values20 = await unit.series.compute(20);
    if (!values9 || !values20) return [];
    const signals: ClosedSignal[] = [];
    const candles = unit.series.all;
    for (let i = 0; i < candles.length; i++) {
      const e9 = values9[i];
      const e20 = values20[i];
      if (e9 === null || e20 === null) continue;
      signals.push({ bucketSec: Math.floor(candles[i].openTime / 1000), ema9: e9, ema20: e20, price: candles[i].close });
    }
    return signals;
  }

  /** Cache the newest EMA pair for a unit's status surface. */
  private async updateLastEma(unit: TimeframeUnit): Promise<void> {
    const values9 = await unit.series.compute(9);
    const values20 = await unit.series.compute(20);
    unit.lastEma9 = values9 && values9.length > 0 ? (values9[values9.length - 1] ?? null) : null;
    unit.lastEma20 = values20 && values20.length > 0 ? (values20[values20.length - 1] ?? null) : null;
  }

  /** Persist settings + per-timeframe cooldown timestamps (JSON file; DB untouched). */
  private persistState(): void {
    const lastAlertBullishAt: Record<string, number> = {};
    const lastAlertBearishAt: Record<string, number> = {};
    for (const [timeframe, unit] of this.units) {
      const last = unit.pipeline.getLastAlertAt();
      lastAlertBullishAt[timeframe] = last.bullish;
      lastAlertBearishAt[timeframe] = last.bearish;
    }
    this.deps.store.save({
      settings: this.settings,
      runtime: { lastAlertBullishAt, lastAlertBearishAt },
    });
  }
/** Process one CLOSED candle end-to-end for its timeframe unit (guarded). */
  private async processClosedCandle(candle: ClosedCandleInput, timeframe: string): Promise<void> {
    const unit = this.units.get(timeframe);
    if (!unit) return;
    try {
      const emaCandle: EmaCandle = {
        openTime: candle.time * 1000,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        closeTime: candle.time * 1000 + unit.bucketSec * 1000,
        volume: 0,
      };
      // Append + cap the unit's retained series, then recompute BOTH EMAs from
      // the closed series (the forming candle is never part of it).
      let all = [...unit.series.all, emaCandle];
      if (all.length > MAX_SERIES_CANDLES) all = all.slice(all.length - MAX_SERIES_CANDLES);
      unit.series.setCandles(all);
      const values9 = await unit.series.compute(9);
      const values20 = await unit.series.compute(20);
      if (!values9 || !values20) {
        await this.updateLastEma(unit);
        this.broadcast(false);
        return; // insufficient history yet — EMAs unavailable, nothing to detect
      }
      const idx = values9.length - 1;
      const e9 = values9[idx];
      const e20 = values20[idx];
      unit.lastEma9 = e9;
      unit.lastEma20 = e20;
      if (e9 === null || e20 === null) {
        this.broadcast(false);
        return;
      }

      const outcome = unit.pipeline.onClosedCandle(
        { bucketSec: candle.time, ema9: e9, ema20: e20, price: candle.close },
        closeMsOf(timeframe, candle.time),
      );

      if (outcome.alert) {
        unit.lastAlert = {
          direction: outcome.alert.direction,
          price: outcome.alert.price,
          atMs: Date.now(),
          bucketSec: outcome.alert.bucketSec,
        };
        this.persistState();
        await this.deliverNotification(unit, outcome.alert);
      }
      this.broadcast(false);
    } catch (err) {
      console.log(
        `[EMA ALERT] closed-candle processing error (engine continues): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Broadcast state to all WS clients when something user-visible changed. */
  private broadcast(force: boolean): void {
    const snap = this.statusSnapshot();
    const key = JSON.stringify([
      snap.enabled,
      snap.alertTimeframes,
      snap.sessionOpenNow,
      snap.pushSubscriptions,
      Object.entries(snap.states).map(([tf, s]) => [tf, s.enabled, s.relationship, s.pending, s.lastAlert, s.ready]),
    ]);
    if (!force && key === this.lastBroadcastKey) return;
    this.lastBroadcastKey = key;
    try {
      this.deps.broadcast({ type: "emaAlert", state: snap });
    } catch {
      /* WS fan-out must never break the engine */
    }
  }

  /** Build the notification content and hand it to the push service. */
  private async deliverNotification(
    unit: TimeframeUnit,
    alert: { direction: ReversalDirection; price: number; bucketSec: number },
  ): Promise<void> {
    const direction = alert.direction;
    const relationText = direction === "bullish" ? "EMA 9 > EMA 20" : "EMA 9 < EMA 20";
    const closeMs = closeMsOf(unit.timeframe, alert.bucketSec);
    const body =
      [
        this.deps.instrumentLabel,
        `${direction === "bullish" ? "Bullish" : "Bearish"} reversal confirmed`,
        `Timeframe: ${timeframeUnitLabel(unit.timeframe)} — ${relationText}`,
        `Confirmation: ${this.settings.confirmationCandles} closed candles`,
        `Price: ${formatPrice(alert.price)}`,
        `Time: ${formatNyDateTime(closeMs)} NY (${formatManilaDateTime(closeMs)} PH)`,
        "Session: New York",
      ].join("\n");

    if (!this.deps.push.configured) {
      console.log(
        `[EMA ALERT] ${timeframeUnitLabel(unit.timeframe)} ${direction.toUpperCase()} reversal confirmed (push not configured — see VAPID_* in backend/.env)`,
      );
      return;
    }
    const result = await this.deps.push.sendAll({
      title: "AURA EMA REVERSAL",
      body,
      direction,
      timeframe: unit.timeframe,
      price: alert.price,
      confirmedAtMs: closeMs,
      confirmationCandles: this.settings.confirmationCandles,
      instrument: this.deps.instrumentLabel,
    });
    console.log(
      `[EMA ALERT] ${timeframeUnitLabel(unit.timeframe)} ${direction.toUpperCase()} reversal confirmed → push sent=${result.sent} pruned=${result.pruned}`,
    );
  }
}
function relationshipOf(ema9: number | null, ema20: number | null): "bull" | "bear" | "flat" | null {
  if (ema9 === null || ema20 === null) return null;
  if (ema9 > ema20) return "bull";
  if (ema9 < ema20) return "bear";
  return "flat";
}

function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return "—";
  return price.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** "2026-09-03 09:34" — America/New_York wall clock (DST-safe Intl). */
function formatNyDateTime(ms: number): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
  return `${date} ${time}`;
}

/** "2026-09-03 21:34" — Asia/Manila display equivalent (fixed +8, no DST). */
function formatManilaDateTime(ms: number): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
    return `${date} ${time}`;
}
