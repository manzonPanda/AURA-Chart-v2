/**
 * PostgreSQL connection layer for AURA market data.
 *
 * Reads connection params from /etc/aura/postgres.env (root-only file created
 * on the Oracle VM). NEVER prints credentials; the password is surfaced only via
 * `pgSecrets()` for registration with the existing crash-path SecretRedactor.
 *
 * This is a LOCALHOST-only pooler (127.0.0.1:5432). PostgreSQL is never exposed
 * through nginx, Oracle security lists, or the public internet.
 *
 * The pool is a process-wide singleton.
 */
import { readFileSync } from "node:fs";
import { env } from "node:process";
import pg from "pg";

const { Pool } = pg;

/** Non-sensitive connection metadata for logging/diagnostics only. */
export interface PgConfigSummary {
  configured: boolean;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
}

/** Parse /etc/aura/postgres.env (KEY=value lines, optional `export` prefix). */
function loadEnvFile(path: string): Record<string, string> {
  try {
    const raw = readFileSync(path, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/** Full config incl. secrets (caller must never log the password). */
export interface PgConfig extends PgConfigSummary {
  connectionString: string;
  password: string;
}

/**
 * Load Postgres connection config. Priority:
 *   1. Explicit env override (DATABASE_URL/AURA_DB_URL set by the process).
 *   2. /etc/aura/postgres.env (canonical root-only file on the VM).
 * Returns null when unconfigured.
 */
export function loadPgConfig(): PgConfig | null {
  const connOverride = (env.AURA_DB_URL || env.DATABASE_URL || "").trim();
  const connectionString = connOverride || (loadEnvFile("/etc/aura/postgres.env").AURA_DB_URL || "").trim();
  if (!connectionString) return null;

  const summary = summarizeConnectionString(connectionString);
  return { ...summary, connectionString, password: extractPassword(connectionString) };
}

/** Extract the password from a postgresql:// URL (empty if absent). */
function extractPassword(cs: string): string {
  const m = cs.match(/^postgres(?:ql)?:\/\/[^:]+:([^@]+)@/);
  return m ? m[1] : "";
}

/** Build a non-sensitive summary from a connection string. */
function summarizeConnectionString(cs: string): PgConfigSummary {
  let host = "127.0.0.1";
  let port = 5432;
  let database = "aura";
  let user = "aura_app";
  let ssl = false;
  const m = cs.match(/^postgres(?:ql)?:\/\/(?:([^:]+)(?::[^/]*)?@)?([^/:]+)(?::(\d+))?\/([^?]+)/);
  if (m) {
    user = m[1] || user;
    host = m[2] || host;
    port = m[3] ? Number(m[3]) : port;
    database = m[4] || database;
  }
  // Localhost (or Unix-socket directory) connections need no TLS — scram-sha-256
  // over loopback is the transport; PostgreSQL is never reached off-box.
  return { configured: true, host, port, database, user, ssl: false };
}

let pool: pg.Pool | null = null;

/**
 * Returns the singleton Postgres pool, or null if Postgres is not configured.
 */
export function getPgPool(): pg.Pool | null {
  if (pool) return pool;
  const cfg = loadPgConfig();
  if (!cfg || !cfg.connectionString) return null;

  // LOCALHOST-ONLY enforcement: PostgreSQL must never be reached off-box (no
  // nginx, no Oracle security-list ingress, no public exposure). Fail fast on a
  // misconfigured URL instead of silently shipping candles elsewhere.
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost" && !cfg.host.startsWith("/")) {
    throw new Error(
      `[DB PG] refusing non-loopback PostgreSQL host "${cfg.host}" — connections are localhost-only by design`,
    );
  }

  pool = new Pool({
    connectionString: cfg.connectionString,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (err: Error) => {
    console.error("[DB PG] idle client error:", err.message);
  });
  return pool;
}

/** Non-sensitive summary for startup logging. */
export function pgEnvSummary(): PgConfigSummary {
  const cfg = loadPgConfig();
  if (!cfg) return { configured: false, host: "", port: 0, database: "", user: "", ssl: false };
  const { connectionString: _cs, password: _pw, ...summary } = cfg;
  return summary;
}

/**
 * Current PG secrets (for registration with SecretRedactor). Never logged
 * directly — only masked as `[REDACTED]` in crash-path logs.
 */
export function pgSecrets(): string[] {
  const cfg = loadPgConfig();
  return cfg ? [cfg.password] : [];
}
