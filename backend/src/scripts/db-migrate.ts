/**
 * `npm run db:migrate`
 *
 * Applies every SQL file in supabase/migrations/ (sorted by filename) to the
 * Supabase Postgres database. All migration SQL is written idempotently
 * (IF NOT EXISTS / OR REPLACE), so re-running is always safe.
 *
 * Requires SUPABASE_DB_URL — the postgres connection string from
 * Supabase → Project Settings → Database (use the pooler URI, port 6543).
 * Alternatively paste the SQL into the Supabase SQL editor by hand.
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

async function main(): Promise<void> {
  const connectionString = (process.env.SUPABASE_DB_URL || "").trim();
  if (!connectionString) {
    console.error(
      "SUPABASE_DB_URL is not set — add the Supabase postgres (pooler) connection string to backend/.env, " +
        "or apply supabase/migrations/*.sql manually in the Supabase SQL editor.",
    );
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    console.log("No migration files found in", MIGRATIONS_DIR);
    return;
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Supabase pooler serves its own cert
  });
  await client.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
      console.log(`applied ${file}`);
    }
    console.log("DB migrations complete.");
  } finally {
    await client.end();
  }
}

void main().catch((err) => {
  console.error("db-migrate failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});