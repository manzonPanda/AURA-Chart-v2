import "dotenv/config";

export interface Config {
  port: number;
  host: string;
  /**
   * Legacy Supabase archive access (READ path + fallback only). The archive is
   * NEVER migrated and NEVER written by active market-data collection — Oracle
   * PostgreSQL is the canonical store. Kept configured so legacy archive rows
   * stay queryable through /api/candles/db when PostgreSQL is unavailable.
   */
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
  /**
   * Capital.com provider — the ONLY active market-data provider. Server-side
   * ONLY — the key/custom password never reach the frontend, logs, or the
   * bundle. Unset → the Capital module is inert and NO market data is
   * collected (there is deliberately NO IG fallback — IG is retired).
   */
  capital: {
    apiKey: string;
    /** The API custom password — NOT the web-login password. */
    apiPassword: string;
    /** Account identifier (email) used by POST /api/v1/session. */
    identifier: string;
    baseUrl: string;
    streamingUrl: string;
  };
  /** First-run seed for the EMA alert master switch (before any UI change). */
  emaAlertEnabledOnBoot: boolean;
  /**
   * Automatic Capital REST reconciliation of GENUINE missing candles (the
   * DISTINCT OHLC-stream hole repair). Values are clamped again at construction
   * (`resolveReconcileSettings`), so a bad env value can never weaken the
   * forming-bucket / safety-lag guards. PostgreSQL-only by construction — it
   * needs `insertBackfilledBatch`, which the Supabase shim does not have.
   */
  reconcile: {
    /** RECONCILE_ENABLED=off/false/0 disables the scheduler entirely. */
    enabled: boolean;
    /** RECONCILE_INTERVAL_MINUTES — minutes between runs (default 15). */
    intervalMinutes: number;
    /** RECONCILE_LOOKBACK_MINUTES — scan depth (default 180; ≤999 = one page). */
    lookbackMinutes: number;
    /** RECONCILE_SAFETY_LAG_MINUTES — newest completed buckets skipped (default 3). */
    safetyLagMinutes: number;
  };
}

/**
 * Reads configuration ONLY from process environment variables loaded via
 * dotenv (backend/.env). None of these are ever exposed to the frontend or
 * bundled with `VITE_*` variables.
 *
 * IG environment variables are intentionally ABSENT: IG is retired from
 * active collection. Removed: IG_API_KEY, IG_USERNAME, IG_PASSWORD,
 * IG_ACCOUNT_ID, IG_BASE_URL, IG_DAX_EPIC, IG_GOLD_EPIC, IG_SILVER_EPIC,
 * IG_SESSION_VERSION, IG_ENCRYPT_FLAG. (Legacy IG secrets may still exist in
 * /etc/aura / backend/.env — they are unused by this runtime and are left for
 * a separate explicit secret-removal task.)
 */
export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT || 8787),
    host: process.env.HOST || "0.0.0.0",
    // Server-side ONLY (service-role key never reaches the browser or logs).
    // When unset, candle persistence + /api/candles/db degrade gracefully; the
    // realtime Capital stream is unaffected.
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
    // Capital.com provider — the ONLY active market-data provider, loaded
    // exclusively from env (never committed). Unset values make the Capital
    // module inert and collection stops entirely (no IG fallback).
    capital: {
      apiKey: (process.env.CAPITAL_API_KEY || "").trim(),
      apiPassword: process.env.CAPITAL_API_PASSWORD || "",
      identifier: (process.env.CAPITAL_IDENTIFIER || "").trim(),
      baseUrl: (process.env.CAPITAL_API_BASE_URL || "https://api-capital.backend-capital.com")
        .trim()
        .replace(/\/+$/, ""),
      streamingUrl: (
        process.env.CAPITAL_STREAMING_URL ||
        "wss://api-streaming-capital.backend-capital.com/connect"
      ).trim(),
    },
    emaAlertEnabledOnBoot: ["on", "true", "1"].includes(
      (process.env.EMA_ALERT_ENABLED || "").trim().toLowerCase(),
    ),
    // Automatic reconciliation — ENABLED by default (opt-out, not opt-in): the
    // whole point is that genuine holes are repaired without an operator. Non-
    // numeric values fall back to the defaults inside resolveReconcileSettings.
    reconcile: {
      enabled: !["off", "false", "0"].includes(
        (process.env.RECONCILE_ENABLED || "").trim().toLowerCase(),
      ),
      intervalMinutes: Number(process.env.RECONCILE_INTERVAL_MINUTES || 15),
      lookbackMinutes: Number(process.env.RECONCILE_LOOKBACK_MINUTES || 180),
      safetyLagMinutes: Number(process.env.RECONCILE_SAFETY_LAG_MINUTES || 3),
    },
  };
}

/** Capital.com provider credentials — env-only, never logged. */
export interface CapitalCredentials {
  apiKey: string;
  apiPassword: string;
  identifier: string;
  baseUrl: string;
  streamingUrl: string;
}

/**
 * Capital.com is usable ONLY with key + custom password + identifier. The
 * base/streaming URLs always have defaults, so they cannot block. Null-safe on
 * `cfg.capital` (unit tests construct partial config shapes). Because IG is
 * retired, `isCapitalConfigured` is now the ONLY provider-readiness signal:
 * when it is false, NO market data is collected at all.
 */
export function isCapitalConfigured(cfg: Config): boolean {
  return Boolean(
    cfg.capital?.apiKey &&
      cfg.capital?.apiPassword &&
      cfg.capital?.identifier &&
      cfg.capital?.baseUrl,
  );
}
