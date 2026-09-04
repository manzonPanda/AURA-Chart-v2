/**
 * EMA Reversal Alert — REST client + shared types (frontend mirror of the
 * backend model in backend/src/emaAlert/emaAlertConfig.ts).
 *
 * The BACKEND is the runtime source of truth for the alert configuration
 * (detection runs server-side); this client only reads/patches it. The
 * browser never holds VAPID private keys, IG credentials or subscription
 * tokens beyond its own PushSubscription.
 */

/** Shared types mirror the backend model in backend/src/emaAlert/emaAlertConfig.ts. */

const API_BASE = "/api";

export type ConfirmationCandles = 1 | 2 | 3 | 4 | 5;
export type EmaAlertTimeframe = "MINUTE_1" | "MINUTE_3";

export interface EmaAlertSettings {
  enabled: boolean;
  alertTimeframes: EmaAlertTimeframe[];
  confirmationCandles: ConfirmationCandles;
  bullishEnabled: boolean;
  bearishEnabled: boolean;
  sessionTimezone: "America/New_York";
  sessionStart: string;
  sessionEnd: string;
  cooldownMinutes: number;
}

/** Per-timeframe snapshot from the engine. */
export interface EmaAlertUnitState {
  timeframe: EmaAlertTimeframe;
  enabled: boolean;
  relationship: "bull" | "bear" | "flat" | null;
  pending: { direction: "bullish" | "bearish"; confirmations: number; needed: number } | null;
  lastAlert: { direction: "bullish" | "bearish"; price: number; atMs: number; bucketSec: number } | null;
  lastEma9: number | null;
  lastEma20: number | null;
  closedCandles: number;
  ready: boolean;
}

export interface EmaAlertState {
  enabled: boolean;
  alertTimeframes: EmaAlertTimeframe[];
  sessionOpenNow: boolean;
  pushConfigured: boolean;
  pushSubscriptions: number;
  states: Record<string, EmaAlertUnitState>;
}

export interface EmaAlertSettingsResponse {
  settings: EmaAlertSettings;
  state: EmaAlertState;
}

/** WS broadcast alias — the message shape is identical to the REST state. */
export type EmaAlertStateMsg = EmaAlertState;

export const DEFAULT_EMA_ALERT_SETTINGS: EmaAlertSettings = {
  enabled: false,
  alertTimeframes: ["MINUTE_1", "MINUTE_3"],
  confirmationCandles: 2,
  bullishEnabled: true,
  bearishEnabled: true,
  sessionTimezone: "America/New_York",
  sessionStart: "09:30",
  sessionEnd: "16:00",
  cooldownMinutes: 30,
};

async function parseError(res: Response): Promise<never> {
  let message = res.statusText || "Request failed";
  let code = "HTTP_ERROR";
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (body?.error) message = body.error;
    if (body?.code) code = body.code;
  } catch {
    /* non-JSON error body */
  }
  throw new Error(`${code}: ${message}`);
}

export async function fetchEmaAlert(): Promise<EmaAlertSettingsResponse> {
  const res = await fetch(`${API_BASE}/ema-alert`);
  if (!res.ok) await parseError(res);
  return (await res.json()) as EmaAlertSettingsResponse;
}

export async function saveEmaAlertSettings(
  patch: Partial<EmaAlertSettings>,
): Promise<EmaAlertSettingsResponse> {
  const res = await fetch(`${API_BASE}/ema-alert/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as EmaAlertSettingsResponse;
}

export async function fetchPushPublicKey(): Promise<{ configured: boolean; publicKey: string | null }> {
  const res = await fetch(`${API_BASE}/ema-alert/push/public-key`);
  if (!res.ok) await parseError(res);
  return (await res.json()) as { configured: boolean; publicKey: string | null };
}

interface SubscribeBody {
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

export async function subscribePush(subscription: SubscribeBody["subscription"]): Promise<void> {
  const res = await fetch(`${API_BASE}/ema-alert/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription }),
  });
  if (!res.ok) await parseError(res);
}

export async function unsubscribePush(endpoint: string): Promise<void> {
  const res = await fetch(`${API_BASE}/ema-alert/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) await parseError(res);
}

export async function sendTestPush(): Promise<{ ok: boolean; sent: number; reason?: string }> {
  const res = await fetch(`${API_BASE}/ema-alert/push/test`, { method: "POST" });
  if (!res.ok) await parseError(res);
  return (await res.json()) as { ok: boolean; sent: number; reason?: string };
}

/** VAPID applicationServerKey conversion (RFC 8292 base64url → bytes). */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
