import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../config.js";

/**
 * Server-side Supabase admin client (service-role key — backend ONLY, never
 * sent to the browser or logged). Returns null when Supabase is not configured
 * so every consumer degrades gracefully: candle persistence is optional, the
 * realtime IG stream is not.
 */
export function createSupabaseAdmin(cfg: Config["supabase"]): SupabaseClient | null {
  if (!cfg.url || !cfg.serviceKey) return null;
  try {
    return createClient(cfg.url, cfg.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (err) {
    console.error(
      "[DB] failed to create Supabase client:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}