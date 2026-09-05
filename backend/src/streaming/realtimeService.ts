import { WebSocket } from "ws";
import type { CandleStore } from "../db/candleStore.js";
import type { IgClient } from "../ig/client.js";
import { instrumentMetaFor, type InstrumentMeta } from "../market/instruments.js";
import { ClientSeeders } from "./clientSeed.js";
import { IgStreamClient } from "./igStream.js";
import {
  clientWantsCandle,
  createInstrumentUnit,
  persistenceInstrumentFor,
  processInstrumentTick,
  type InstrumentUnit,
} from "./instrumentPipeline.js";
import type { ClosedCandle, IngTick, StreamState } from "./types.js";
import {
  TIMEFRAME_BUCKET_SEC as RESOLUTION_BUCKET_SEC,
  STREAM_TIME_FRAMES,
  isPersistedTimeframe,
  timeframeLabel,
} from "./timeframes.js";

/**
 * The chart timeframes → bucket seconds. The registry and its persistence
 * rules live in ./timeframes.ts (MINUTE_1 is the ONLY persisted frame;
 * MINUTE_3 is a live in-memory overlay + history derived from 1m). Re-exported
 * under the historic `RESOLUTION_BUCKET_SEC` name so existing importers of
 * ../realtime.js keep working unchanged.
 */
export { RESOLUTION_BUCKET_SEC, STREAM_TIME_FRAMES };

/** "HH:MM:SS.mmm" (UTC) — shared by the temporary candle diagnostics below. */
const fmtMs = (ms: number): string => new Date(ms).toISOString().slice(11, 23);

/** A connected frontend browser socket, bound to one instrument+timeframe. */
interface WsClient {
  ws: WebSocket;
  epic: string;
  resolution: string;
  bucketSec: number;
  /** Set once we've told the client it's (re)connected / streaming. */
  alive: boolean;
  /** Diagnostics: candle+status frames pushed to this client. */
  framesSent: number;
}

/** How long to wait before the FIRST retry of a Lightstreamer connection. */
const STREAM_RECONNECT_DELAY_MS = 5_000;
/** Backoff cap for consecutive never-live reconnects (IG-outage friendliness):
 *  5s → 10s → 20s → 40s → 60s, reset to 5s by every LIVE. */
const STREAM_RECONNECT_MAX_DELAY_MS = 60_000;
/** Periodic truthful-status heartbeat so the UI's tick counters/ages stay fresh
 *  without any polling of IG (frames only travel over OUR websocket). */
const STATUS_HEARTBEAT_MS = 30_000;

/**
 * Owns ONE Lightstreamer connection PER configured instrument (all sharing the
 * single IgClient REST session), routes every tick to EXACTLY ONE per-
 * instrument InstrumentUnit (own CandleAggregatorSet, forming candles, tick
 * counter, last price, rollover tracking, persistence and diagnostics — see
 * instrumentPipeline.ts), and pushes candle/status frames tagged with `epic`
 * to the WS clients subscribed to that instrument.
 *
 * Phase 1 contract (DAX + Spot Gold, capture-only Gold):
 *   - instruments[0] (the constructor epic, DAX) stays the DEFAULT: it keeps
 *     the historic snapshot()/stateNow() semantics and is the ONLY instrument
 *     whose closed candles reach onClosedCandle listeners (the EMA alert
 *     engine — untouched). Gold closes are persisted + relayed but NEVER feed
 *     the DAX EMA state.
 *   - Unregistered EPICs keep the exact historic 1-decimal behavior via the
 *     registry's conservative fallback.
 */
export class RealtimeService {
  /** Per-instrument state — NEVER shared across EPICs. Keyed by raw EPIC. */
  private readonly units = new Map<string, InstrumentUnit>();
  /** One Lightstreamer connection per instrument (shared IG session). */
  private readonly streams = new Map<string, IgStreamClient>();
  /** Per-instrument truthful IG connection state. */
  private readonly streamStates = new Map<string, StreamState>();
  private readonly lastStateChangeMs = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly clients = new Set<WsClient>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private started = false;
  /** The constructor epic — snapshot()/stateNow()/closed-candle listeners. */
  private readonly defaultEpic: string;
  /** One in-flight connect attempt at a time PER instrument (auth awaits can
   *  overlap timers; the loser must never tear down the winner's fresh stream). */
  private readonly connecting = new Set<string>();
  /** Consecutive connect attempts PER instrument that ended WITHOUT ever
   *  reaching LIVE — drives the reconnect backoff. Reset by every LIVE. */
  private readonly failedAttempts = new Map<string, number>();
  /** Instruments whose CURRENT stream has reached LIVE (reset on stream
   *  replacement) — a healthy session end reconnects promptly, a never-live
   *  attempt backs off. */
  private readonly reachedLive = new Set<string>();

  constructor(
    private readonly ig: IgClient,
    epic: string,
    /** Optional completed-candle persistence — null disables DB writes. */
    private readonly candleStore: CandleStore | null = null,
  ) {
    const meta = instrumentMetaFor(epic);
    this.units.set(meta.epic, createInstrumentUnit(meta.epic, meta.label, meta.decimals));
    this.defaultEpic = meta.epic;
  }

  /**
   * Register an ADDITIONAL instrument (Phase 1: Spot Gold). MUST be called
   * before start(). The default instrument (constructor epic) is unchanged:
   * DAX keeps its identity, precision, calendar and its exclusive closed-
   * candle listener feed; the added instrument is capture-only (aggregate →
   * persist → relay) until the EMA engine becomes multi-instrument-aware.
   */
  addInstrument(meta: InstrumentMeta): void {
    if (this.started) throw new Error("addInstrument() must be called before start()");
    const key = meta.epic.trim();
    if (!key || this.units.has(key)) return;
    this.units.set(key, createInstrumentUnit(key, meta.label, meta.decimals));
  }

  /** Historic single-instrument state — now the DEFAULT instrument's (DAX). */
  get stateNow(): StreamState {
    return this.streamStates.get(this.defaultEpic) ?? "DISCONNECTED";
  }

  /** Closed-candle listeners — alert-engine hook (any streamed timeframe). */
  private readonly closedCandleListeners = new Set<(candle: ClosedCandle, timeframe: string) => void>();

  /**
   * Client-seed hooks — extra first frames for EVERY freshly-added client.
   * Used by index.ts to seed the current EMA-alert snapshot so a reconnect
   * (e.g. after a backend restart) immediately restores UI state instead of
   * waiting for the next closed candle to trigger a broadcast.
   */
  private readonly clientSeeders = new ClientSeeders();

  /** Register a hook returning one auxiliary frame to send to new clients. */
  onClientSeed(seeder: () => Record<string, unknown> | null): void {
    this.clientSeeders.add(seeder);
  }

  /**
   * Register a listener invoked once per COMPLETED candle, immediately after
   * the WS fanout and persistence attempt. Listeners must never throw into
   * the tick path — the engine wraps its own work; this call site is
   * fire-and-forget by contract.
   */
  onClosedCandle(listener: (candle: ClosedCandle, timeframe: string) => void): void {
    this.closedCandleListeners.add(listener);
  }

  /** Send an auxiliary frame to EVERY alive client regardless of timeframe. */
  broadcastAuxiliary(payload: unknown): void {
    for (const client of this.clients) {
      if (!client.alive) continue;
      this.send(client, payload);
    }
  }

  snapshot(): {
    state: StreamState;
    epic: string;
    resolution: string;
    bucketSec: number;
    timeframes: readonly string[];
    ticks: number;
    lastPrice: number | null;
    lastTickAt: number;
    lastTickAgeMs: number | null;
    /** Per-instrument status (additive, Phase 1) — [0] is the default. */
    instruments: Array<{
      epic: string;
      label: string;
      decimals: number;
      state: StreamState;
      ticks: number;
      lastPrice: number | null;
      lastTickAt: number;
      lastTickAgeMs: number | null;
    }>;
  } {
    const unit = this.units.get(this.defaultEpic);
    return {
      state: this.streamStates.get(this.defaultEpic) ?? "DISCONNECTED",
      epic: this.defaultEpic,
      resolution: "",
      bucketSec: 0,
      timeframes: STREAM_TIME_FRAMES,
      ticks: unit?.ticksReceived ?? 0,
      lastPrice: unit?.lastPrice ?? null,
      lastTickAt: unit?.lastTickAt ?? 0,
      lastTickAgeMs: unit && unit.lastTickAt > 0 ? Date.now() - unit.lastTickAt : null,
      instruments: this.instrumentStatuses(),
    };
  }

  /** Truthful per-instrument status — the additive multi-instrument view. */
  private instrumentStatuses(): Array<{
    epic: string;
    label: string;
    decimals: number;
    state: StreamState;
    ticks: number;
    lastPrice: number | null;
    lastTickAt: number;
    lastTickAgeMs: number | null;
  }> {
    return [...this.units.values()].map((unit) => ({
      epic: unit.epic,
      label: unit.label,
      decimals: unit.decimals,
      state: this.streamStates.get(unit.epic) ?? "DISCONNECTED",
      ticks: unit.ticksReceived,
      lastPrice: unit.lastPrice,
      lastTickAt: unit.lastTickAt,
      lastTickAgeMs: unit.lastTickAt > 0 ? Date.now() - unit.lastTickAt : null,
    }));
  }

  /** Start one IG subscription PER instrument. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), STATUS_HEARTBEAT_MS);
    }
    await Promise.all([...this.units.keys()].map((epic) => this.connectStream(epic)));
  }

  stop(): void {
    this.started = false;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.connecting.clear();
    this.failedAttempts.clear();
    this.reachedLive.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const stream of this.streams.values()) stream.disconnect();
    this.streams.clear();
  }

  /**
   * Secret VALUES reachable from this service — the IG client's API key /
   * password and the ACTIVE stream session's CST / X-SECURITY-TOKEN. Consumed
   * ONLY by the crash-path log redactor; never logged directly.
   */
  redactables(): Array<string | undefined> {
    return [
      ...this.ig.redactables(),
      ...[...this.streams.values()].flatMap((stream) => stream.redactables()),
    ];
  }

  /** Register a browser WS client for a given timeframe and send its first frame. */
  addClient(ws: WebSocket, epic: string, resolution: string): boolean {
    if (!this.units.has(epic)) {
      this.sendRaw(ws, {
        type: "error",
        code: "EPIC_MISMATCH",
        error: `The streaming service is bound to [${[...this.units.keys()].join(", ")}]; requested ${epic} is not available on this connection.`,
      });
      return false;
    }
    const bucketSec = RESOLUTION_BUCKET_SEC[resolution];
    const client: WsClient = { ws, epic, resolution, bucketSec, alive: true, framesSent: 0 };
    this.clients.add(client);
    this.sendStatus(client);
    // Seed the freshly-connected client with the CURRENT forming candle for its
    // timeframe so the historical↔live handoff is seamless (the client can
    // merge it into the last historical bucket even before the next tick).
    const candle = this.units.get(epic)!.aggregators.getCandleFor(bucketSec);
    if (candle) this.send(client, { type: "candle", epic, timeframe: resolution, ...candle });
        // Auxiliary seed frames (e.g. the EMA-alert snapshot) — a seeder must
    // never break the connect path (ClientSeeders already isolates throwers).
    for (const frame of this.clientSeeders.frames()) {
      this.sendRaw(ws, frame);
    }
    console.log(
      `[WS] client added res=${resolution} epic=${epic} (clients=${this.clients.size}, state=${this.streamStates.get(epic) ?? "DISCONNECTED"}, ticks=${this.units.get(epic)!.ticksReceived})`,
    );
    return true;
  }

  removeClient(ws: WebSocket): void {
    for (const client of this.clients) {
      if (client.ws === ws) {
        this.clients.delete(client);
        console.log(`[WS] client removed res=${client.resolution} framesSent=${client.framesSent} (clients=${this.clients.size})`);
        return;
      }
    }
  }

  private sendRaw(ws: WebSocket, payload: unknown): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    } catch {
      /* socket gone */
    }
  }

  private async connectStream(epic: string): Promise<void> {
    if (this.connecting.has(epic) || !this.started) return;
    this.connecting.add(epic);
    // A fresh attempt supersedes any pending reconnect timer — it must never
    // fire later and tear down the stream this attempt is about to open.
    this.clearReconnectTimer(epic);

    let session;
    try {
      // ALWAYS a fresh IG login on (re)connect: IG invalidates the CST/XST
      // once the Lightstreamer session terminates, so retrying cached tokens
      // earns an instant server rejection — the CONNECTING→DISCONNECTED flap.
      // (IgClient's SESSION_REUSE_WINDOW_MS + 90s failure cooldown keep the
      // login rate safe even when this fires every few seconds.)
      session = await this.ig.getStreamSession({ forceNew: true });
    } catch (err) {
      this.connecting.delete(epic);
      console.warn(
        `[STREAM] IG session unavailable for ${epic} — ${err instanceof Error ? err.message : "unknown error"}; ` +
          `retrying in ${Math.round(this.nextReconnectDelayMs(epic) / 1000)}s`,
      );
      this.setStreamState(epic, "DISCONNECTED");
      this.scheduleReconnect(epic);
      return;
    }

    // A shutdown raced this in-flight auth (stop() ran while we were awaiting
    // the session). NEVER open a new IG connection after shutdown — reconnect
    // stays permanently disabled for the remainder of the process lifetime.
    if (!this.started || !this.units.has(epic)) return;

    // Detach the previous stream BEFORE disconnecting it: its teardown events
    // (and any in-flight ticks) belong to a dead stream and must not be read
    // as a NEW outage — that mistake scheduled a reconnect on every teardown
    // and churned LIVE→DISCONNECTED→CONNECTING even when tokens were healthy.
    const previous = this.streams.get(epic);
    this.streams.delete(epic);
    previous?.disconnect();

    this.reachedLive.delete(epic);
    const unit = this.units.get(epic)!;
    const stream = new IgStreamClient(
      session,
      epic,
      {
        onTick: (tick) => {
          // Events from a replaced (stale) stream are dropped here — only the
          // CURRENT stream feeds the aggregators.
          if (this.streams.get(epic) === stream) this.handleTick(epic, tick);
        },
        onState: (state) => {
          if (this.streams.get(epic) !== stream) return; // stale/teardown event — ignore
          this.setStreamState(epic, state);
        },
      },
      unit.decimals, // per-instrument quoting precision (DAX 1 / Gold 2)
    );
    this.streams.set(epic, stream);
    try {
      stream.connect();
    } catch {
      // connect() throws synchronously when the session is unusable (e.g. no
      // Lightstreamer endpoint). Swallow it here so the async caller never
      // produces an unhandled rejection that would kill the whole server.
      this.streams.delete(epic);
      this.connecting.delete(epic);
      this.setStreamState(epic, "DISCONNECTED");
      this.scheduleReconnect(epic);
      return;
    }
    this.connecting.delete(epic);
  }

  private handleTick(epic: string, tick: IngTick): void {
    // EPIC routing happens HERE — before ANY aggregation state is touched.
    // A tick for EPIC X can only ever reach X's InstrumentUnit (its own
    // aggregators, forming candle, counters, rollover and persistence).
    const unit = this.units.get(epic);
    if (!unit) return;
    const results = processInstrumentTick(unit, tick);

    const sec = (s: number) => new Date(s * 1000).toISOString();
    const instrumentTag = unit.label.split(" /")[0] || epic; // "DAX" | "Spot Gold"

    // One pass per timeframe. Every IG tick fans out to BOTH the canonical 1m
    // aggregator (closed candles are persisted) and the in-memory 3m overlay
    // (never persisted — formed purely for the live WS forming-candle UX) —
    // ALWAYS within THIS tick's own instrument unit.
    for (const result of results) {
      const { timeframe, bucketSec, forming: candle, closed, firstAnchor } = result;
      if (!candle) continue;

      const tag = timeframeLabel(timeframe).toUpperCase(); // "1M" | "3M"

      // TEMPORARY: one-shot anchor report for the FIRST bucket of this stream,
      // per instrument+timeframe. If the backend started mid-bucket, our open
      // is the first RECEIVED tick and will NOT match IG's bucket-boundary open.
      if (firstAnchor) {
        const delta = firstAnchor.firstTickMs - candle.time * 1000;
        console.log(
          `[${instrumentTag} ${tag} CANDLE SESSION-START]\n` +
            `instrument=${epic}\n` +
            `bucket=${fmtMs(candle.time * 1000).slice(0, 8)}\n` +
            `firstTick=${fmtMs(firstAnchor.firstTickMs)}\n` +
            `firstTickDeltaMs=${delta}\n` +
            `ticksInBucket=${firstAnchor.ticksInBucket}\n` +
            `O=${candle.open}`,
        );
      }

      if (closed) {
        // A bucket just CLOSED. Dump its full diagnostics: chart OHLC (rounded
        // to THIS instrument's quoting grid), unrounded raw OHLC, tick count +
        // first/last tick timestamps.
        const ls = this.streams.get(epic)?.getStats();
        console.log(
          `[${instrumentTag} ${tag} CANDLE CLOSED]\n` +
            `instrument=${epic}\n` +
            `bucket=${fmtMs(closed.time * 1000).slice(0, 8)}\n` +
            `O=${closed.open}\n` +
            `H=${closed.high}\n` +
            `L=${closed.low}\n` +
            `C=${closed.close}\n` +
            `ticks=${closed.tickCount}\n` +
            `firstTick=${fmtMs(closed.firstTickMs)}\n` +
            `lastTick=${fmtMs(closed.lastTickMs)}\n` +
            `firstTickDeltaMs=${closed.firstTickMs - closed.time * 1000}\n` +
            `lastTickDeltaMs=${closed.lastTickMs - closed.time * 1000}\n` +
            `rawO=${closed.rawOpen ?? "-"} rawH=${closed.rawHigh ?? "-"} rawL=${closed.rawLow ?? "-"} rawC=${closed.rawClose ?? "-"}\n` +
            `lsUpdates=${ls?.updatesReceived ?? "-"} lsNoPrice=${ls?.noPriceUpdates ?? "-"} ticksTotal=${unit.ticksReceived} clients=${this.clients.size}`,
        );
        // COMPLETED candle → Supabase upsert — ONLY for the canonical persisted
        // timeframe (MINUTE_1) and ALWAYS under THIS instrument's EPIC as the
        // ohlc_candles identity. MINUTE_3 is an in-memory overlay and is
        // deliberately NEVER written. Fire-and-forget, idempotent — see
        // persistClosedCandle; never touches the realtime path.
        if (isPersistedTimeframe(timeframe)) {
          this.persistClosedCandle(unit, closed, timeframe);
        }
        // Closed-candle listeners (EMA alert engine) — Phase 1: the DEFAULT
        // instrument (DAX) ONLY. Gold is capture-only: its closes persist and
        // relay but can NEVER enter the DAX EMA state. The listener signature
        // stays (candle, timeframe) so the engine is untouched.
        if (epic === this.defaultEpic) {
          for (const listener of this.closedCandleListeners) {
            try {
              listener(closed, timeframe);
            } catch {
              /* a listener must never break the realtime path */
            }
          }
        }
        console.log(
          `[${instrumentTag} ${tag}] ROLLOVER oldBucket=${sec(closed.time)} newBucket=${sec(candle.time)}`,
        );
      }

      // Per-client fan-out: only clients subscribed to THIS instrument AND
      // timeframe receive its forming candle (frames carry `epic`).
      for (const client of this.clients) {
        if (!clientWantsCandle(client, epic, bucketSec)) continue;
        this.send(client, { type: "candle", epic, timeframe, ...candle });
      }
    }
  }

  /**
   * Persist one COMPLETED candle to Supabase under the given timeframe (the
   * canonical MINUTE_1 in practice — this method is never called for the 3m
   * overlay). Fire-and-forget: the promise is fully self-contained (CandleStore
   * logs and swallows its own errors) so a DB outage can never reject into the
   * tick path, slow the stream, or change live chart behavior. Duplicate-safe
   * by upsert on (instrument, timeframe, bucket_time) — reconnects/restarts
   * re-close the same bucket and converge on one row.
   */
  private persistClosedCandle(unit: InstrumentUnit, candle: ClosedCandle, timeframe: string): void {
    if (!this.candleStore) return;
    const instrument = persistenceInstrumentFor(timeframe, unit);
    if (!instrument) return;
    void this.candleStore.saveClosedCandle(instrument, timeframe, candle);
  }

  private setStreamState(epic: string, state: StreamState): void {
    if (this.streamStates.get(epic) === state) return;
    this.streamStates.set(epic, state);
    this.lastStateChangeMs.set(epic, Date.now());
    if (state === "LIVE") {
      // This stream is healthy: reset the failure backoff and cancel any
      // pending reconnect timer so a stale timer can never tear it down.
      this.failedAttempts.set(epic, 0);
      this.reachedLive.add(epic);
      this.clearReconnectTimer(epic);
    } else if (state === "DISCONNECTED") {
      this.failedAttempts.set(
        epic,
        this.reachedLive.has(epic)
          ? 0 // a healthy session ended (IG kick/maintenance) — reconnect promptly
          : Math.min((this.failedAttempts.get(epic) ?? 0) + 1, 8), // never-live attempt → back off
      );
      this.reachedLive.delete(epic);
    }
    const unit = this.units.get(epic);
    const tag = unit?.label.split(" /")[0] || epic;
    console.log(
      `[STREAM:${tag}] IG state -> ${state} (ticks=${unit?.ticksReceived ?? 0}${
        unit?.lastTickAt ? `, lastTickAge=${Math.round((Date.now() - unit.lastTickAt) / 1000)}s` : ", no ticks yet"
      })`,
    );
    this.broadcastStatus(epic);

    if (state === "DISCONNECTED" && this.started) {
      this.scheduleReconnect(epic);
    }
  }

  /** Push an instrument's truthful status to ITS OWN subscribed clients only. */
  private broadcastStatus(epic: string): void {
    for (const client of this.clients) {
      if (client.alive && client.epic === epic) this.sendStatus(client);
    }
  }

  /** Heartbeat: every alive client is refreshed with ITS OWN instrument status. */
  private heartbeat(): void {
    for (const client of this.clients) if (client.alive) this.sendStatus(client);
  }

  private nextReconnectDelayMs(epic: string): number {
    return Math.min(
      STREAM_RECONNECT_DELAY_MS * 2 ** (this.failedAttempts.get(epic) ?? 0),
      STREAM_RECONNECT_MAX_DELAY_MS,
    );
  }

  private scheduleReconnect(epic: string): void {
    if (!this.started || this.reconnectTimers.has(epic)) return;
    const delay = this.nextReconnectDelayMs(epic);
    console.log(
      `[STREAM] reconnect scheduled in ${Math.round(delay / 1000)}s for ${epic} (failedAttempts=${this.failedAttempts.get(epic) ?? 0})`,
    );
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(epic);
      void this.connectStream(epic);
    }, delay);
    this.reconnectTimers.set(epic, timer);
  }

  private clearReconnectTimer(epic: string): void {
    const timer = this.reconnectTimers.get(epic);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(epic);
  }

  private sendStatus(client: WsClient): void {
    const unit = this.units.get(client.epic);
    if (!unit) return;
    this.send(client, {
      type: "status",
      epic: client.epic,
      status: this.streamStates.get(client.epic) ?? "DISCONNECTED",
      ticks: unit.ticksReceived,
      price: unit.lastPrice,
      lastTickAt: unit.lastTickAt,
    });
  }

  private send(client: WsClient, payload: unknown): void {
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(payload));
        client.framesSent += 1;
      }
    } catch {
      /* socket gone — removed on 'close' */
    }
  }
}