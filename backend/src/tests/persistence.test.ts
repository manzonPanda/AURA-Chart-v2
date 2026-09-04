/**
 * Persistence + reconnect tests — backend/data/*.json durability and the WS
 * reconnect seed (Node test runner via tsx: npm --prefix backend run test).
 *
 * Covers: settings reload after restart, push-subscription reload after
 * restart (incl. 400/404/410 pruning), per-timeframe cooldown-state reload,
 * atomic JSON writes, and the emaAlert snapshot seeded to freshly-connected
 * WS clients. Uses real stores against temp files — no secrets, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import webpush from "web-push";

import { EmaAlertSettingsStore, defaultRuntimeState, toRuntimeRecord } from "../emaAlert/settingsStore.js";
import { PushService } from "../emaAlert/pushService.js";
import { writeJsonAtomic } from "../emaAlert/atomicFile.js";
import { defaultEmaAlertSettings } from "../emaAlert/emaAlertConfig.js";
import { ClientSeeders } from "../streaming/clientSeed.js";

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-ema-test-"));
  return dir;
}

function tempFile(dir: string, name: string): string {
  return path.join(dir, name);
}

test("backend restart reloads settings from backend/data (real store round-trip)", () => {
  const dir = tempDir();
  try {
    const file = tempFile(dir, "ema-alert-settings.json");
    const writer = new EmaAlertSettingsStore(file, null);
    writer.save({
      settings: { ...defaultEmaAlertSettings(), enabled: true, confirmationCandles: 3, cooldownMinutes: 15, alertTimeframes: ["MINUTE_3"] },
      runtime: {
        lastAlertBullishAt: { MINUTE_1: 111, MINUTE_3: 222 },
        lastAlertBearishAt: { MINUTE_1: 0, MINUTE_3: 333 },
      },
    });
    // "Restart": a brand-new store instance over the same file.
    const reloaded = new EmaAlertSettingsStore(file, null).load();
    assert.equal(reloaded.settings.enabled, true);
    assert.equal(reloaded.settings.confirmationCandles, 3);
    assert.equal(reloaded.settings.cooldownMinutes, 15);
    assert.deepEqual(reloaded.settings.alertTimeframes, ["MINUTE_3"]);
    assert.equal(reloaded.runtime.lastAlertBullishAt["MINUTE_1"], 111);
    assert.equal(reloaded.runtime.lastAlertBullishAt["MINUTE_3"], 222);
    assert.equal(reloaded.runtime.lastAlertBearishAt["MINUTE_3"], 333);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("per-timeframe cooldown state round-trips; legacy scalar runtime maps onto BOTH timeframes", () => {
  assert.deepEqual(toRuntimeRecord(555), { MINUTE_1: 555, MINUTE_3: 555 });
    assert.deepEqual(toRuntimeRecord({ MINUTE_1: 1, MINUTE_3: 2, bogus: "x" }), { MINUTE_1: 1, MINUTE_3: 2 });
  assert.deepEqual(toRuntimeRecord(undefined), {});
  const dir = tempDir();
  try {
    const file = tempFile(dir, "ema-alert-settings.json");
    new EmaAlertSettingsStore(file, null).save({
      settings: defaultEmaAlertSettings(),
      runtime: { lastAlertBullishAt: { MINUTE_1: 7 }, lastAlertBearishAt: defaultRuntimeState().lastAlertBearishAt },
    });
    const reloaded = new EmaAlertSettingsStore(file, null).load();
    assert.equal(reloaded.runtime.lastAlertBullishAt["MINUTE_1"], 7);
    assert.equal(reloaded.runtime.lastAlertBullishAt["MINUTE_3"] ?? 0, 0, "per-timeframe keys are preserved, not smeared");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

test("backend restart reloads push subscriptions; 400 (VAPID rotation) and 404/410 prune them", async () => {
  const dir = tempDir();
  const originalSend = (webpush as unknown as Record<string, unknown>).sendNotification as (sub: unknown, body?: string | Buffer, opts?: unknown) => Promise<void>;
  try {
    const keys = webpush.generateVAPIDKeys();
    const vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:aura-test@example.com" };
    const file = tempFile(dir, "push-subscriptions.json");
    const sub = { endpoint: "https://push.example.com/ep-1", keys: { p256dh: "k-p256dh", auth: "k-auth" } };

    // First "process": register a subscription.
    const first = new PushService(vapid, file);
    assert.equal(first.configured, true);
    first.add(sub);
    assert.equal(first.count(), 1);

    // Restart: a brand-new PushService over the same file sees the subscription.
    const restarted = new PushService(vapid, file);
    assert.equal(restarted.count(), 1, "subscription must survive a backend restart");

    // Delivery reaches the reloaded subscription.
    (webpush as unknown as Record<string, unknown>).sendNotification = async (): Promise<void> => {};
    const ok = await restarted.sendAll({ title: "t" });
    assert.equal(ok.sent, 1);

    // 410 (device gone) prunes and persists the prune.
    (webpush as unknown as Record<string, unknown>).sendNotification = async (): Promise<void> => {
      const err = new Error("gone") as Error & { statusCode?: number };
      err.statusCode = 410;
      throw err;
    };
    const pruned410 = await restarted.sendAll({ title: "t" });
    assert.equal(pruned410.sent, 0);
    assert.equal(pruned410.pruned, 1);
    assert.equal(new PushService(vapid, file).count(), 0, "prune must be persisted");

    // 400 (VAPID key rotation) also prunes so the user can re-enable push.
    const second = new PushService(vapid, file);
    second.add(sub);
    (webpush as unknown as Record<string, unknown>).sendNotification = async (): Promise<void> => {
      const err = new Error("bad request") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    };
    const pruned400 = await second.sendAll({ title: "t" });
    assert.equal(pruned400.pruned, 1, "VAPID-rotation 400s must prune stale subscriptions");
    assert.equal(new PushService(vapid, file).count(), 0);

    // Transient failures (5xx) keep the subscription.
    second.add(sub);
    (webpush as unknown as Record<string, unknown>).sendNotification = async (): Promise<void> => {
      const err = new Error("upstream") as Error & { statusCode?: number };
      err.statusCode = 503;
      throw err;
    };
    const transient = await second.sendAll({ title: "t" });
    assert.equal(transient.pruned, 0);
    assert.equal(new PushService(vapid, file).count(), 1, "transient failures must not prune");
  } finally {
    (webpush as unknown as Record<string, unknown>).sendNotification = originalSend;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJsonAtomic: valid JSON lands, no temp files remain, crash-safe pattern used", () => {
  const dir = tempDir();
  try {
    const file = tempFile(dir, "atomic.json");
    writeJsonAtomic(file, { hello: "aura", n: 42 });
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { hello: string; n: number };
    assert.equal(parsed.hello, "aura");
    assert.equal(parsed.n, 42);
    // The temp+rename pattern must not leave *.tmp droppings behind.
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
    // A second write fully replaces the content (no append/merge semantics).
    writeJsonAtomic(file, { replaced: true });
    const reparsed = JSON.parse(fs.readFileSync(file, "utf8")) as { replaced: boolean };
    assert.equal(reparsed.replaced, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type SentFrame = Record<string, unknown>;

test("reconnect seed: registered seeders deliver the CURRENT emaAlert snapshot to new clients", () => {
  // NOTE: the seed registry is exercised directly (streaming/clientSeed.ts) —
  // the lightstreamer-client package keeps the Node loop alive once imported,
  // so importing RealtimeService in a test would hang the runner. RealtimeService
  // composes this class and sends each frame via sendRaw (verified by tsc wiring).
  const state = {
    enabled: true,
    alertTimeframes: ["MINUTE_1", "MINUTE_3"],
    sessionOpenNow: true,
    pushConfigured: true,
    pushSubscriptions: 2,
    states: {},
  };
  const seeders = new ClientSeeders();
  seeders.add(() => ({ type: "emaAlert", state }));

  const frames = seeders.frames() as Array<{ type: string; state: typeof state }>;
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "emaAlert");
  assert.equal(frames[0].state.pushSubscriptions, 2);
  assert.deepEqual(frames[0].state.alertTimeframes, ["MINUTE_1", "MINUTE_3"]);
});

test("reconnect seed: a throwing seeder never breaks connect nor blocks the remaining seeders", () => {
  const seeders = new ClientSeeders();
  seeders.add(() => {
    throw new Error("seeder blew up");
  });
  seeders.add(() => ({ type: "emaAlert", state: { enabled: false, states: {} } }));
  seeders.add(() => null); // nothing to send — skipped silently

  const frames = seeders.frames();
  assert.equal(frames.length, 1, "only the healthy seeder's frame is delivered");
  assert.equal((frames[0] as { type: string }).type, "emaAlert");
});
});