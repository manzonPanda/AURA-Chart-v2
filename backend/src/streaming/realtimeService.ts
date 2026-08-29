import { WebSocket } from "ws";
import type { CandleStore } from "../db/candleStore.js";
import type { IgClient } from "../ig/client.js";
import { CandleAggregatorSet } from "./aggregator.js";
import { IgStreamClient } from "./igStream.js";
import type { ClosedCandle, IngTick, RealtimeCandle, StreamState } from "./types.js";

/**
 * The ONLY chart resolution → bucket seconds. AURA Chart is a single 3-minute
 * timeframe: bucket = floor(ts / 180) * 180 (pure epoch, no timezone).
 */
export const RESOLUTION_BUCKET_SEC: Record<string, number> = {
  MINUTE_3: 180,
};

export const STREAM_TIME_FRAMES = Object.keys(RESOLUTION_BUCKET_SEC);

/** "HH:MM:SS.mmm" (UTC) — shared by the temporary candle diagnostics below. */
const fmtMs = (ms: number): string => new Date(ms).toISOString().slice(11, 23);

/** A connected frontend browser socket, bound to one timeframe. */
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

/** How long to wait before retrying the Lightstreamer connection. Auth failures
 *  stay gated by IgClient's own 90 s cooldown — this only paces socket retries. */
const STREAM_RECONNECT_DELAY_MS = 5_000;
/** Periodic truthful-status heartbeat so the UI's tick counters/ages stay fresh
 *  without any polling of IG (frames only travel over OUR websocket). */
const STATUS_HEARTBEAT_MS = 30_000;

/**
 * Owns the single IG Lightstreamer connection, fans every tick into a set of
 * candle aggregators (one per timeframe), and pushes the resulting candle
 * updates to the WS clients currently subscribed to that timeframe. Also
 * streams truthful status events so the UI never fakes "LIVE" from the socket
 * alone.
 */
export class RealtimeService {
  private stream: IgStreamClient | null = null;
  private aggregators: CandleAggregatorSet;
  private readonly clients = new Set<WsClient>();
  private state: StreamState = "DISCONNECTED";
  private lastStateChange = 0;
  private ticksReceived = 0;
  private lastPrice: number | null = null;
  /** Arrival time (server clock) of the last REAL IG tick — 0 = none ever. */
  private lastTickAt = 0;
  /** Previous 3-minute bucket, for rollover diagnostics. */
  private lastBucketSec = 0;
  /** One-shot flag: log how the first forming candle was anchored at stream start. */
  private loggedFirstAnchor = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    private readonly ig: IgClient,
    private readonly epic: string,
    /** Optional completed-candle persistence — null disables DB writes. */
    private readonly candleStore: CandleStore | null = null,
  ) {
    this.aggregators = new CandleAggregatorSet(
      Object.entries(RESOLUTION_BUCKET_SEC).map(([resolution, bucketSec]) => ({
        timeframe: resolution,
        bucketSec,
      })),
    );
  }

  get stateNow(): StreamState {
    return this.state;
  }

  snapshot(): {
    state: StreamState;
    epic: string;
    resolution: string;
    bucketSec: number;
    timeframes: string[];
    ticks: number;
    lastPrice: number | null;
    lastTickAt: number;
    lastTickAgeMs: number | null;
  } {
    return {
      state: this.state,
      epic: this.epic,
      resolution: "",
      bucketSec: 0,
      timeframes: STREAM_TIME_FRAMES,
      ticks: this.ticksReceived,
      lastPrice: this.lastPrice,
      lastTickAt: this.lastTickAt,
      lastTickAgeMs: this.lastTickAt > 0 ? Date.now() - this.lastTickAt : null,
    };
  }

  /** Start the IG subscription. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.broadcastStatus(), STATUS_HEARTBEAT_MS);
    }
    await this.connectStream();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.stream?.disconnect();
    this.stream = null;
  }

  /**
   * Secret VALUES reachable from this service — the IG client's API key /
   * password and the ACTIVE stream session's CST / X-SECURITY-TOKEN. Consumed
   * ONLY by the crash-path log redactor; never logged directly.
   */
  redactables(): Array<string | undefined> {
    return [...this.ig.redactables(), ...(this.stream?.redactables() ?? [])];
  }

  /** Register a browser WS client for a given timeframe and send its first frame. */
  addClient(ws: WebSocket, epic: string, resolution: string): boolean {
    if (this.epic && epic !== this.epic) {
      this.sendRaw(ws, {
        type: "error",
        code: "EPIC_MISMATCH",
        error: `The streaming service is bound to ${this.epic}; requested ${epic} is not available on this connection.`,
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
    const candle = this.aggregators.getCandleFor(bucketSec);
    if (candle) this.send(client, { type: "candle", timeframe: resolution, ...candle });
    console.log(`[WS] client added res=${resolution} (clients=${this.clients.size}, state=${this.state}, ticks=${this.ticksReceived})`);
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

  private async connectStream(): Promise<void> {
    let session;
    try {
      // Re-uses the existing IG auth (incl. the 90s failure cooldown).
      session = await this.ig.getStreamSession();
    } catch (err) {
      this.handleState("DISCONNECTED");
      this.scheduleReconnect();
      return;
    }

    // A shutdown raced this in-flight auth (stop() ran while we were awaiting
    // the session). NEVER open a new IG connection after shutdown — reconnect
    // stays permanently disabled for the remainder of the process lifetime.
    if (!this.started) return;

    if (this.stream) this.stream.disconnect();

    this.stream = new IgStreamClient(session, this.epic, {
      onTick: (tick) => this.handleTick(tick),
      onState: (state) => this.handleState(state),
    });
    try {
      this.stream.connect();
    } catch {
      // connect() throws synchronously when the session is unusable (e.g. no
      // Lightstreamer endpoint). Swallow it here so the async caller never
      // produces an unhandled rejection that would kill the whole server.
      this.stream = null;
      this.handleState("DISCONNECTED");
      this.scheduleReconnect();
    }
  }

  private handleTick(tick: IngTick): void {
    this.ticksReceived += 1;
    this.lastPrice = tick.price;
    this.lastTickAt = Date.now();
    this.aggregators.onTick(tick);

    const sec = (s: number) => new Date(s * 1000).toISOString();

    // Build the 3-minute forming candle (single timeframe — MINUTE_3).
    const bucketSec = RESOLUTION_BUCKET_SEC["MINUTE_3"];
    const candle = this.aggregators.getCandleFor(bucketSec);

    if (candle) {
      // TEMPORARY: one-shot anchor report for the FIRST bucket of this stream.
      // If the backend started mid-bucket, our open is the first RECEIVED tick
      // and will NOT match IG's bucket-boundary open — this flags that case.
      if (!this.loggedFirstAnchor) {
        this.loggedFirstAnchor = true;
        const stats = this.aggregators.getCurrentStatsFor(bucketSec);
        if (stats && stats.firstTickMs > 0) {
          const delta = stats.firstTickMs - candle.time * 1000;
          console.log(
            `[3M CANDLE SESSION-START]\n` +
              `bucket=${fmtMs(candle.time * 1000).slice(0, 8)}\n` +
              `firstTick=${fmtMs(stats.firstTickMs)}\n` +
              `firstTickDeltaMs=${delta}\n` +
              `ticksInBucket=${stats.tickCount}\n` +
              `O=${candle.open}`,
          );
        }
      }

      if (this.lastBucketSec === 0) this.lastBucketSec = candle.time;
      if (candle.time > this.lastBucketSec) {
        // A bucket just CLOSED. Dump its full diagnostics: chart OHLC (rounded
        // MID), unrounded raw OHLC, tick count + first/last tick timestamps.
        const ls = this.stream?.getStats();
        const closed = this.aggregators.getClosedCandleFor(bucketSec);
        if (closed) {
          console.log(
            `[3M CANDLE CLOSED]\n` +
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
              `lsUpdates=${ls?.updatesReceived ?? "-"} lsNoPrice=${ls?.noPriceUpdates ?? "-"} ticksTotal=${this.ticksReceived} clients=${this.clients.size}`,
          );
          // COMPLETED candle → Supabase upsert (fire-and-forget, idempotent —
          // see persistClosedCandle; never touches the realtime path).
          this.persistClosedCandle(closed);
        }
        console.log(
          `[3M] ROLLOVER oldBucket=${sec(this.lastBucketSec)} newBucket=${sec(candle.time)}`,
        );
        this.lastBucketSec = candle.time;
      } else if (candle.time < this.lastBucketSec) {
        this.lastBucketSec = candle.time; // stream reset / stale tick safety
      }

      for (const client of this.clients) {
        if (!client.alive) continue;
        this.sendCandle(client, { type: "candle", timeframe: "MINUTE_3", ...candle });
      }
    }
  }

  /**
   * Persist one COMPLETED candle to Supabase. Fire-and-forget: the promise is
   * fully self-contained (CandleStore logs and swallows its own errors) so a
   * DB outage can never reject into the tick path, slow the stream, or change
   * live chart behavior. Duplicate-safe by upsert on
   * (instrument, timeframe, bucket_time) — reconnects/restarts re-close the
   * same bucket and converge on one row.
   */
  private persistClosedCandle(candle: ClosedCandle): void {
    if (!this.candleStore) return;
    void this.candleStore.saveClosedCandle(this.epic, "MINUTE_3", candle);
  }

  private handleState(state: StreamState): void {
    this.state = state;
    this.lastStateChange = Date.now();
    console.log(`[STREAM] IG state -> ${state} (ticks=${this.ticksReceived}${this.lastTickAt ? `, lastTickAge=${Math.round((Date.now() - this.lastTickAt) / 1000)}s` : ", no ticks yet"})`);
    this.broadcastStatus();

    if (state === "DISCONNECTED" && this.started) {
      this.scheduleReconnect();
    }
  }

  /** Push the truthful current status to every alive client (also the heartbeat). */
  private broadcastStatus(): void {
    const msg = {
      type: "status",
      status: this.state,
      ticks: this.ticksReceived,
      price: this.lastPrice,
      lastTickAt: this.lastTickAt,
    };
    for (const client of this.clients) if (client.alive) this.send(client, msg);
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectStream();
    }, STREAM_RECONNECT_DELAY_MS);
  }

  private sendCandle(client: WsClient, candle: RealtimeCandle & { type: string; timeframe: string }): void {
    this.send(client, candle);
  }

  private sendStatus(client: WsClient): void {
    this.send(client, {
      type: "status",
      status: this.state,
      ticks: this.ticksReceived,
      price: this.lastPrice,
      lastTickAt: this.lastTickAt,
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