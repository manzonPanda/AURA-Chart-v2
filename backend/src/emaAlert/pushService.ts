/**
 * Web Push notification service (VAPID).
 *
 * The backend acts as the push application server: it holds the VAPID keypair
 * (backend/.env — NEVER logged) and the list of browser push subscriptions.
 * The browser only registers/manages its own subscription (frontend/sw.js +
 * services/pushClient.ts); delivery is server → push-service → phone, so the
 * alert reaches the phone even when AURA is not open.
 *
 * Subscriptions persist in a small JSON file (backend/data/push-
 * subscriptions.json) so a backend restart does not force re-subscription.
 * SAFETY: subscription endpoints/tokens are never logged — only counts.
 */
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { writeJsonAtomic } from "./atomicFile.js";

export interface PushSubscriptionShape {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const SUBSCRIPTION_TTL_SECONDS = 3600;

export class PushService {
  private readonly subscriptions = new Map<string, PushSubscriptionShape>();
  private loaded = false;

  constructor(
    private readonly vapid: VapidConfig,
    private readonly storePath: string,
  ) {
    // Required once for every push send — the application-server signature.
    // The private key is consumed by web-push here and never logged/exposed.
    if (this.configured) {
      webpush.setVapidDetails(this.vapid.subject, this.vapid.publicKey, this.vapid.privateKey);
    }
  }

  /** True when a VAPID keypair is configured (public key + private key). */
  get configured(): boolean {
    return Boolean(this.vapid.publicKey && this.vapid.privateKey);
  }

  /** Public VAPID key for the browser subscription flow (safe to expose). */
  publicKey(): string | null {
    return this.configured ? this.vapid.publicKey : null;
  }

  /** Subscription COUNT only — shapes/tokens never leave the server. */
  count(): number {
    this.ensureLoaded();
    return this.subscriptions.size;
  }

  add(subscription: PushSubscriptionShape): void {
    this.ensureLoaded();
    this.subscriptions.set(subscription.endpoint, subscription);
    this.persist();
  }

  remove(endpoint: string): void {
    this.ensureLoaded();
    if (this.subscriptions.delete(endpoint)) this.persist();
  }

  /**
   * Send one JSON payload to every subscription. Stale subscriptions are
   * pruned:
   *   - 404/410 — the endpoint is gone/expired (device uninstalled, browser
   *     cleared data, push service rotated the subscription).
   *   - 400      — most commonly a VAPID key rotation made the stored
   *     subscription's audience invalid; these are pruned too so the user can
   *     simply re-enable push from the UI (see README "VAPID rotation").
   * Failures are logged WITHOUT endpoint details or tokens.
   */
  async sendAll(payload: Record<string, unknown>): Promise<{ sent: number; pruned: number }> {
    this.ensureLoaded();
    if (!this.configured || this.subscriptions.size === 0) return { sent: 0, pruned: 0 };
    let sent = 0;
    let pruned = 0;
    const body = JSON.stringify(payload);
    for (const sub of [...this.subscriptions.values()]) {
      try {
        await webpush.sendNotification(sub, body, { TTL: SUBSCRIPTION_TTL_SECONDS });
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 400 || status === 404 || status === 410) {
          this.subscriptions.delete(sub.endpoint);
          pruned += 1;
        } else {
          // 401/403/429/5xx etc. — transient/unknown; keep the subscription.
          console.log(`[EMA ALERT] push delivery failed (status=${status ?? "unknown"})`);
        }
      }
    }
    if (pruned > 0) this.persist();
    return { sent, pruned };
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as { subscriptions?: PushSubscriptionShape[] };
      for (const s of parsed.subscriptions ?? []) {
        if (s && typeof s.endpoint === "string" && s.keys?.p256dh && s.keys?.auth) {
          this.subscriptions.set(s.endpoint, s);
        }
      }
    } catch {
      /* no file yet — starts empty */
    }
  }

    private persist(): void {
    try {
      writeJsonAtomic(this.storePath, { subscriptions: [...this.subscriptions.values()] });
    } catch (err) {
      console.log(
        `[EMA ALERT] subscription file write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
