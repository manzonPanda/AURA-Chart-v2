import type { Pool } from "pg";
import type { ChartDrawingRecord, ChartDrawingStore } from "../routes/chartDrawings.js";

/**
 * PostgreSQL implementation of the chart-drawing store — the ONLY runtime
 * reader/writer of `public.chart_drawings` (migration 0004_chart_drawings.sql).
 *
 * Every statement is fully parameterized (a table name cannot be a parameter,
 * so the constructor validates the optional schema-qualified identifier — it is
 * ONLY ever supplied by server code or the isolated store tests, never by a
 * request).
 *
 * WRITE SEMANTICS: `replace()` is a single transaction — DELETE the whole
 * (user_id, instrument, timeframe) scope, then INSERT the submitted array in
 * order. `sort_order` preserves CandleKit's array order (z-order) so a restored
 * scope stacks identically after a refresh; an empty array is a valid save that
 * clears the scope. Any failure rolls back, so the scope is never left half
 * written.
 */
const TABLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export class PgChartDrawingStore implements ChartDrawingStore {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    table = "public.chart_drawings",
  ) {
    if (!TABLE_IDENTIFIER.test(table)) {
      throw new Error(`Invalid chart-drawing table name: ${JSON.stringify(table)}`);
    }
    this.table = table;
  }

  async load(userId: string, instrument: string, timeframe: string): Promise<ChartDrawingRecord[]> {
    const res = await this.pool.query(
      `select drawing_key, drawing_type, drawing_data, sort_order
         from ${this.table}
        where user_id = $1 and instrument = $2 and timeframe = $3
        order by sort_order asc, created_at asc, drawing_key asc`,
      [userId, instrument, timeframe],
    );
    return res.rows.map(
      (row): ChartDrawingRecord => ({
        id: row.drawing_key,
        tool: row.drawing_type,
        // JSONB column → pg already hands back a parsed object; tolerate text.
        data:
          typeof row.drawing_data === "string"
            ? (JSON.parse(row.drawing_data) as Record<string, unknown>)
            : ((row.drawing_data ?? {}) as Record<string, unknown>),
      }),
    );
  }

  async replace(
    userId: string,
    instrument: string,
    timeframe: string,
    drawings: readonly ChartDrawingRecord[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `delete from ${this.table} where user_id = $1 and instrument = $2 and timeframe = $3`,
        [userId, instrument, timeframe],
      );
      for (let i = 0; i < drawings.length; i++) {
        const d = drawings[i];
        await client.query(
          `insert into ${this.table}
             (user_id, instrument, timeframe, drawing_key, drawing_type, drawing_data, sort_order)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [userId, instrument, timeframe, d.id, d.tool, JSON.stringify(d.data), i],
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async clear(userId: string, instrument: string, timeframe: string): Promise<void> {
    await this.pool.query(
      `delete from ${this.table} where user_id = $1 and instrument = $2 and timeframe = $3`,
      [userId, instrument, timeframe],
    );
  }
}
