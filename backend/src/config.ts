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
    sessionVersion: string;
    sendEncryptFlag: boolean;
  };
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
      // Wire format of POST /session, replicating the official API Companion:
      //   version header "1" + RSA(base64(password)) cipher.
      sessionVersion: (process.env.IG_SESSION_VERSION || "1").trim() || "1",
      sendEncryptFlag: (process.env.IG_ENCRYPT_FLAG ?? "on").trim().toLowerCase() !== "off",
    },
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