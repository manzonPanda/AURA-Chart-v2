-- 0004_chart_drawings.sql — per-user drawing-tool persistence.
--
-- One row per COMMITTED drawing, scoped to the OWNING USER + the chart scope
-- (instrument × timeframe) it was drawn on — TradingView-style: drawings
-- survive refresh, timeframe switches and redeploys, and never bleed between
-- users. AURA's Hono backend is the only reader/writer
-- (backend/src/routes/chartDrawings.ts): it validates the Bearer session
-- against the Trading Dashboard and resolves the owning `user_id`, so this
-- table is never reachable from the browser directly — same access model as
-- ohlc_candles (backend writes, no RLS policies needed).
--
-- Save semantics: WHOLE-ARRAY REPLACE inside one transaction — the backend
-- DELETEs the (user_id, instrument, timeframe) scope and re-INSERTs the
-- submitted array. `sort_order` preserves the array position (drawing z-order:
-- later renders on top) so the stacking order is byte-identical after a
-- refresh. The UNIQUE constraint makes a re-run/replayed PUT idempotent — a
-- drawing can never duplicate within its scope.
--
-- Apply via: Supabase SQL editor (paste) or `npm --prefix backend run db:migrate`
-- with SUPABASE_DB_URL set. Safe to run repeatedly (all statements are guarded).

create table if not exists public.chart_drawings (
    id uuid primary key default gen_random_uuid(),

    -- Trading Dashboard user id (plain text: this database has NO users table
    -- and deliberately no FK — ownership is validated server-side per request
    -- from the session token, never from client-supplied identity).
    user_id text not null,

    instrument text not null,
    timeframe text not null,

    -- Drawing identity + tool from CandleKit's serialized Drawing
    -- ({ id, tool, points, style }): `drawing_key` = Drawing.id (unique per
    -- scope), `drawing_type` = Drawing.tool.
    drawing_key text not null,
    drawing_type text not null,

    -- The remainder of the serialized drawing: { points: [{time, price}...],
    -- style: {...} }. JSONB (not json) so future engine fields persist
    -- without a schema change, and so the backend could query inside a
    -- drawing if ever needed.
    drawing_data jsonb not null,

    -- Array position of the drawing within the saved export — the stacking
    -- order (z-order). Restored on load so redraws keep their exact overlap
    -- order across refreshes.
    sort_order integer not null default 0,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    unique (user_id, instrument, timeframe, drawing_key)
);

-- Scope reads always filter by (user_id, instrument, timeframe) — the unique
-- constraint's leading columns already back this, but an explicit index keeps
-- the GET load a direct index-only scan regardless of constraint details.
create index if not exists chart_drawings_scope_idx
    on public.chart_drawings (user_id, instrument, timeframe);

-- Keep updated_at fresh on writes (the whole-array replace only INSERTs, so
-- the trigger simply stamps each re-inserted row's save time).
create or replace function public.chart_drawings_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists chart_drawings_touch on public.chart_drawings;
create trigger chart_drawings_touch
    before update on public.chart_drawings
    for each row execute function public.chart_drawings_touch_updated_at();
