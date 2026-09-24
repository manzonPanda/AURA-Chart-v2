import "dotenv/config";

export interface Config {
  port: number;
  host: string;
  /**
   * Legacy Supabase naming retained ONLY for: (1) the secret redactor, which
   * still scrubs the Supabase service-role key should it surface in a stack
   * trace/env dump (the env var remains present on the VM), and (2) the
   * offline `npm run db:*` audit scripts which exercise the Supabase-backed
   * CandleStore directly against a Supabase project. The live runtime NEVER
   * constructs a Supabase client — Oracle PostgreSQL (see `persistence` below)
   * is the sole runtime persistence path.
   */
  supabase: {
    url: string;
    serviceKey: string;
    table: string;
  };
  /**
   * Neutral runtime persistence settings — decoupled from the legacy Supabase
   * naming so the runtime config no longer implies a Supabase dependency. `table`
   * is sourced from CANDLES_TABLE (default `ohlc_candles`) and is what
   * PgCandleStore writes to / reads from on the Oracle PostgreSQL target.
   */
  persistence: {
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
   * Trading Dashboard (aura-backend) API — the P2 server-to-server boundary.
   * THIS backend is the only component that talks to it; the browser reaches
   * trading data exclusively through this backend's same-origin /api/trading
   * proxy routes. Env-driven (DASHBOARD_API_URL); the fallback matches the
   * local dev Dashboard backend but application logic never hardcodes it.
   * No credentials are stored here — every request carries the caller's own
   * Bearer session token, forwarded opaquely and never logged.
   */
  dashboard: {
    baseUrl: string;
    /** Outbound request timeout in ms — bounded client behavior. */
    timeoutMs: number;
  };
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
    /**
     * RECONCILE_LOOKBACK_MINUTES — scan depth for every RECURRING run
     * (default 180). 999 minutes ≈ one Capital REST page; larger values are
     * safely tiled by the existing downloader pagination (999-minute pages).
     */
    lookbackMinutes: number;
    /** RECONCILE_SAFETY_LAG_MINUTES — newest completed buckets skipped (default 3). */
    safetyLagMinutes: number;
    /**
     * RECONCILE_STARTUP_LOOKBACK_MINUTES — extended scan depth for the FIRST
     * reconciliation run after backend startup only (default 7200 = 5 days).
     * All subsequent scheduled runs use lookbackMinutes (default 180).
     * This enables recovery of candles lost during an extended PC outage.
     */
    startupLookbackMinutes: number;
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
    // realtime Capital stream is unaffected. Retained for the secret redactor
    // (scrubs this key from any env-dump/stack-trace) and the offline `db:*`
    // audit scripts — NOT used by the live runtime, which streams to PostgreSQL
    // via `persistence.table` / CANDLES_TABLE below.
    supabase: {
      url: (process.env.SUPABASE_URL || "").trim(),
      serviceKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
      table: (process.env.SUPABASE_CANDLES_TABLE || "ohlc_candles").trim(),
    },
    // ── Runtime persistence (Oracle PostgreSQL / PgCandleStore) ────────────────
    // Neutral table-name source for the canonical runtime store. The live path
    // reads ONLY this value — never config.supabase.table — so the runtime
    // config no longer implies a Supabase dependency.
    persistence: {
      table: (process.env.CANDLES_TABLE || "ohlc_candles").trim(),
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
    // Trading Dashboard (aura-backend) boundary. DASHBOARD_API_URL wins;
    // the default is the local dev Dashboard backend. Trailing slashes are
    // stripped so path joins are deterministic. Timeout is clamped to a
    // sane range (1s–30s) so a bad env value cannot hang request handling.
    dashboard: {
      baseUrl: (process.env.DASHBOARD_API_URL || "http://localhost:5001")
        .trim()
        .replace(/\/+$/, ""),
      timeoutMs: Math.min(30_000, Math.max(1_000, Number(process.env.DASHBOARD_API_TIMEOUT_MS) || 10_000)),
    },
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
      // FIRST RUN ONLY — the immediate startup recovery pass (see
      // CapitalReconciler.start()). Recurring runs never use this value.
      startupLookbackMinutes: Number(process.env.RECONCILE_STARTUP_LOOKBACK_MINUTES || 7200),
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
