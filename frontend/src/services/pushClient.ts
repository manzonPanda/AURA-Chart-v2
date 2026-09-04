/**
 * Browser push-subscription management (the browser's ONLY alert duty).
 *
 * Flow: register /sw.js → ask permission → PushManager.subscribe with the
 * backend's public VAPID key → POST the subscription to the backend. Delivery
 * itself is server → push service → phone (the browser need not be open).
 *
 * Web Push requires a SECURE CONTEXT (https, or localhost during dev). On a
 * plain-HTTP origin this module truthfully reports "unavailable" instead of
 * pretending notifications work.
 */
import { fetchPushPublicKey, subscribePush, unsubscribePush, urlBase64ToUint8Array } from "./emaAlertApi";

export type PushAvailability =
  | "supported"
  | "insecure-context"
  | "no-service-worker"
  | "no-push-manager";

export function pushAvailability(): PushAvailability {
  if (typeof window === "undefined") return "no-service-worker";
  if (window.isSecureContext !== true) return "insecure-context";
  if (!("serviceWorker" in navigator)) return "no-service-worker";
  if (!("PushManager" in window)) return "no-push-manager";
  return "supported";
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushAvailability() !== "supported") return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

export interface EnablePushResult {
  ok: boolean;
  endpoint?: string;
  reason?: string;
}

/** Register the SW, request permission, subscribe, and register server-side. */
export async function enablePush(): Promise<EnablePushResult> {
  const availability = pushAvailability();
  if (availability !== "supported") {
    return {
      ok: false,
      reason:
        availability === "insecure-context"
          ? "Push needs a secure context — serve AURA over HTTPS (certbot) or localhost."
          : "This browser does not support Web Push.",
    };
  }
  try {
    const { configured, publicKey } = await fetchPushPublicKey();
    if (!configured || !publicKey) {
      return { ok: false, reason: "Push is not configured on the server — set VAPID_* in backend/.env." };
    }
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const subscription =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      }));
    const json = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh: string; auth: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, reason: "The browser returned an incomplete push subscription." };
    }
    await subscribePush({ endpoint: json.endpoint, keys: json.keys });
    return { ok: true, endpoint: json.endpoint };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/permission|denied/i.test(message)) {
      return { ok: false, reason: "Notification permission was denied in the browser." };
    }
    return { ok: false, reason: `Push subscription failed: ${message}` };
  }
}

/** Unsubscribe the browser and remove the subscription server-side. */
export async function disablePush(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = (await reg?.pushManager.getSubscription()) ?? null;
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await unsubscribePush(endpoint);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
