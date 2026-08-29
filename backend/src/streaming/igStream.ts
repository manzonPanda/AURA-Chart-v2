import LSPkg from "lightstreamer-client";
import type { LightstreamerClient, Subscription, SubscriptionUpdateInfo } from "lightstreamer-client";
import type { StreamSessionInfo } from "../ig/client.js";
import type { IngTick, StreamState } from "./types.js";

/**
 * Thin wrapper around the official Lightstreamer JS client that:
 *   - connects using the CST / X-SECURITY-TOKEN from the REST login (never
 *     hardcoded),
 *   - subscribes to the IG real-time tick item `CHART:<epic>:TICK` in DISTINCT
 *     mode (a notification per tick — ideal for candle aggregation),
 *   - maps Lightstreamer status strings onto our four UI states,
 *   - emits parsed {@link IngTick} objects with NO credentials.
 *
 * Credentials arrive here only from {@link StreamSessionInfo}; the browser and
 * the websocket relay never see them.
 */

const TICK_ITEM_FIELDS = ["BID", "OFR", "LTP", "LTV", "TTV", "UTM"] as const;

function mapStatus(status: string): StreamState {
  if (status.startsWith("CONNECTED:") || status === "CONNECTED") return "LIVE";
  if (status.startsWith("CONNECTING")) return "CONNECTING";
  if (
    status.includes("WILL-RETRY") ||
    status.includes("TRYING-RECONNECTION") ||
    status === "STALLED"
  ) {
    return "RECONNECTING";
  }
  if (status.startsWith("DISCONNECTED")) return "DISCONNECTED";
  return "CONNECTING";
}

function toNumber(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export interface TickHandler {
  onTick(tick: IngTick): void;
  onState(state: StreamState): void;
}

/** A single active Lightstreamer session built lazily on first connect(). */
export class IgStreamClient {
  private client: LightstreamerClient | null = null;
  private subscription: Subscription | null = null;
  private state: StreamState = "DISCONNECTED";
  private ticksReceived = 0;
  private lastPrice: number | null = null;
  private lastTickAt = 0;
  /** Every Lightstreamer update received (incl. ones with no usable price). */
  private updatesReceived = 0;
  /** Updates that carried no usable price (invisible to candle aggregation). */
  private noPriceUpdates = 0;
  /** One-shot warning flag for unusable UTM values. */
  private warnedUtm = false;

  constructor(
    private readonly session: StreamSessionInfo,
    private readonly epic: string,
    private readonly handler: TickHandler,
  ) {}

  getState(): StreamState {
    return this.state;
  }

  getStats(): {
    ticks: number;
    lastPrice: number | null;
    lastTickAt: number;
    updatesReceived: number;
    noPriceUpdates: number;
  } {
    return {
      ticks: this.ticksReceived,
      lastPrice: this.lastPrice,
      lastTickAt: this.lastTickAt,
      updatesReceived: this.updatesReceived,
      noPriceUpdates: this.noPriceUpdates,
    };
  }

  /**
   * Secret VALUES held by this stream session (CST / X-SECURITY-TOKEN) — used
   * ONLY by the crash-path log redactor so fatal logs can never leak them.
   */
  redactables(): string[] {
    return [this.session.cst, this.session.xSecurityToken];
  }

  connect(): void {
    if (this.client) return; // already running
    // The Lightstreamer endpoint comes from the IG login response body — it is
    // never guessed or hardcoded. A missing endpoint means re-authenticate.
    const endpoint = this.session.endpoint;
    if (!endpoint || !this.session.cst || !this.session.xSecurityToken) {
      this.setState("DISCONNECTED");
      throw new Error("IG Lightstreamer session is missing endpoint/CST/XST — re-authenticate first.");
    }

    const client = new LSPkg.LightstreamerClient(endpoint, "");
    client.connectionDetails.setUser(this.session.accountId || "");
    // IG expects the credential envelope `CST-<cst>|XST-<x-security-token>`.
    client.connectionDetails.setPassword(
      `CST-${this.session.cst}|XST-${this.session.xSecurityToken}`,
    );
    client.connectionOptions.setReconnectTimeout(4_000);
    client.connectionOptions.setSlowingEnabled(false);

    client.addListener({
      onStatusChange: (status: string) => {
        const state = mapStatus(status);
        this.setState(state);
      },
    });

    const subscription = new LSPkg.Subscription(
      "DISTINCT",
      [`CHART:${this.epic}:TICK`],
      [...TICK_ITEM_FIELDS],
    );
    subscription.setRequestedSnapshot("yes");
    subscription.addListener({
      onSubscription: () => {
        console.log(`[IG STREAM] CONNECTED sub=CHART:${this.epic}:TICK`);
        this.setState("LIVE");
      },
      onSubscriptionError: (code: number, message: string) => {
        // Subscription rejected (e.g. epic not streamable / account permission).
        console.warn(`[IG] DAX subscription error code=${code} msg=${message}`);
        this.setState("DISCONNECTED");
      },
      onItemUpdate: (info) => this.handleUpdate(info),
    });

    client.subscribe(subscription);
    client.connect();

    // VERIFY the exact subscription IG accepts (item mode snapshot fields).
    console.log(
      `[IG STREAM] SUBSCRIBE item=CHART:${this.epic}:TICK mode=DISTINCT snapshot=yes ` +
        `fields=${TICK_ITEM_FIELDS.join(",")} host=${new URL(endpoint).host}`,
    );

    this.client = client;
    this.subscription = subscription;
  }

  disconnect(): void {
    if (!this.client) return;
    try {
      this.client.unsubscribe(this.subscription as Subscription);
    } catch {
      /* ignore teardown races */
    }
    try {
      this.client.disconnect();
    } catch {
      /* ignore teardown races */
    }
    this.client = null;
    this.subscription = null;
    this.setState("DISCONNECTED");
  }

  private handleUpdate(info: SubscriptionUpdateInfo): void {
    this.updatesReceived += 1;
    const get = (f: string) => info.getValue(f);
    const bid = toNumber(get("BID"));
    const offer = toNumber(get("OFR"));
    const ltp = toNumber(get("LTP"));
    const parsedUtm = toNumber(get("UTM"));

    // Resolve the price BEFORE rounding so diagnostics keep the raw MID.
    // Prefer MID (bid+offer)/2 for CFD chart parity with the IG trading
    // platform. IG's own charts for index CFDs are quote-based; LTP can be
    // sparse, delayed, or a different print than the bid/offer the platform
    // paints. Fall back: BID → OFR → LTP. Never coerce null to 0/NaN.
    let raw: number | undefined;
    let priceField: "MID" | "BID" | "OFR" | "LTP" = "MID";
    if (bid !== undefined && offer !== undefined) {
      raw = (bid + offer) / 2;
      priceField = "MID";
    } else if (bid !== undefined) {
      raw = bid;
      priceField = "BID";
    } else if (offer !== undefined) {
      raw = offer;
      priceField = "OFR";
    } else if (ltp !== undefined) {
      raw = ltp;
      priceField = "LTP";
    }

    // UTM sanity: IG's UTM is epoch milliseconds. Reject absurd values (0/1,
    // seconds-scaled, or far-future garbage) rather than bucketing candles in
    // the wrong era — fall back to arrival time instead.
    const nowMs = Date.now();
    const MAX_FUTURE_SKEW_MS = 5 * 60_000;
    const utmUsable =
      parsedUtm !== undefined &&
      parsedUtm > 1_000_000_000_000 && // after 2001 in ms (rejects second-scale values)
      parsedUtm <= nowMs + MAX_FUTURE_SKEW_MS;
    if (!utmUsable && !this.warnedUtm) {
      this.warnedUtm = true;
      console.warn(`[STREAM] UTM unusable (raw=${String(parsedUtm)}) — falling back to server arrival time`);
    }
    const ts = utmUsable ? (parsedUtm as number) : nowMs;

    if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
      // No usable price in this update — count it (drop/gap analysis) and skip.
      this.noPriceUpdates += 1;
      return;
    }

    // DAX is quoted to 1 decimal on IG — strip float noise (…0000003). This
    // ROUNDED price feeds the aggregator (the chart). The unrounded `raw` is
    // preserved on the tick only for the candle diagnostics above/below.
    const price = Math.round(raw * 10) / 10;

    const volumeRaw = toNumber(get("LTV"));
    // LTV = LAST TRADED volume (size of the most recent trade), NOT exchange
    // volume. The aggregator sums it per bucket = tick-volume approximation.
    const volume = volumeRaw !== undefined && volumeRaw > 0 ? volumeRaw : 0;

    this.ticksReceived += 1;
    this.lastPrice = price;
    this.lastTickAt = Date.now();

    this.handler.onTick({
      tsMs: ts,
      price,
      volume,
      bid,
      offer,
      ltp,
      arriveMs: nowMs,
      utmMs: utmUsable ? (parsedUtm as number) : undefined,
      priceRaw: raw,
      priceField,
    });
  }

  private setState(state: StreamState): void {
    if (this.state === state) return;
    this.state = state;
    this.handler.onState(state);
  }
}