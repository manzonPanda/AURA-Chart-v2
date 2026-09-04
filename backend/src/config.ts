import "dotenv/config";

/** Default public LIVE gateway — the confirmed working environment for this setup. */
const DEFAULT_BASE_URL = "https://api.ig.com/gateway/deal";

export interface Config {
  port: number;
  host: string;
  ig: {
    apiKey: string;
    username: string;
    password: string;
    accountId: string;
    baseUrl: string;
    defaultEpic: string;
    /**
     * Second instrument (Spot Gold CFD). Unset → DAX-only, exactly the
     * historic behavior. Metadata (label/precision/calendar) for each EPIC
     * lives in ../market/instruments.ts — the config only carries EPICs.
     */
    goldEpic: string;
    sessionVersion: string;
    sendEncryptFlag: boolean;
  };
  supabase: {
    url: string;
    serviceKey: string;
    table: string;
  };
  /** Web Push (VAPID) — server-side alert delivery. Never logged. */
  vapid: {
    publicKey: string;
    privateKey: string;
    subject: string;
  };
  /** First-run seed for the EMA alert master switch (before any UI change). */
  emaAlertEnabledOnBoot: boolean;
}

/**
 * Reads every IG credential ONLY from process environment variables loaded via
 * dotenv (backend/.env). None of these are ever exposed to the frontend or
 * bundled with `VITE_*` variables.
 */
export function loadConfig(): Config {
  const baseUrl = (process.env.IG_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return {
    port: Number(process.env.PORT || 8787),
    host: process.env.HOST || "0.0.0.0",
    ig: {
      apiKey: (process.env.IG_API_KEY || "").trim(),
      username: (process.env.IG_USERNAME || "").trim(),
      password: process.env.IG_PASSWORD || "",
      accountId: (process.env.IG_ACCOUNT_ID || "").trim(),
      baseUrl,
      defaultEpic: (process.env.IG_DAX_EPIC || "").trim(),
      // Spot Gold CFD (Phase 0 multi-instrument). Empty = DAX-only (BC).
      goldEpic: (process.env.IG_GOLD_EPIC || "").trim(),
      // Wire format of POST /session, replicating the official API Companion:
      //   version header "1" + RSA(base64(password)) cipher.
      sessionVersion: (process.env.IG_SESSION_VERSION || "1").trim() || "1",
      sendEncryptFlag: (process.env.IG_ENCRYPT_FLAG ?? "on").trim().toLowerCase() !== "off",
    },
    // Server-side ONLY (service-role key never reaches the browser or logs).
    // When unset, candle persistence + the /api/candles/db endpoint degrade
    // gracefully; the realtime IG stream is unaffected.
    supabase: {
      url: (process.env.SUPABASE_URL || "").trim(),
      serviceKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
      table: (process.env.SUPABASE_CANDLES_TABLE || "ohlc_candles").trim(),
    },
    // Web Push (VAPID) — generate once via: npx web-push generate-vapid-keys
    // The private key NEVER reaches the browser or the logs.
    vapid: {
      publicKey: (process.env.VAPID_PUBLIC_KEY || "").trim(),
      privateKey: (process.env.VAPID_PRIVATE_KEY || "").trim(),
      subject: (process.env.VAPID_SUBJECT || "mailto:aura-alerts@localhost").trim(),
    },
    emaAlertEnabledOnBoot: ["on", "true", "1"].includes(
      (process.env.EMA_ALERT_ENABLED || "").trim().toLowerCase(),
    ),
  };
}

export interface IgCredentials {
  apiKey: string;
  username: string;
  password: string;
  accountId: string;
  baseUrl: string;
  sessionVersion: string;
  sendEncryptFlag: boolean;
}

export function isConfigured(cfg: Config): boolean {
  return Boolean(cfg.ig.apiKey && cfg.ig.username && cfg.ig.password && cfg.ig.baseUrl);
}