/**
 * Heikin Ashi calculation tests — pure Node tests, no browser dependencies.
 * Run with: npm --prefix frontend run test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateHeikinAshi,
  heikinAshiBar,
  updateFormingHeikinAshi,
  sanitizeCandleType,
  loadCandleType,
  saveCandleType,
  DEFAULT_CANDLE_TYPE,
  CANDLE_TYPE_STORAGE_KEY,
  VALID_CANDLE_TYPES,
  CANDLE_TYPE_LABELS,
} from "../src/services/heikinAshi.ts";

/** Helper to create a standard candle. */
function candle(ts, open, high, low, close, volume) {
  return { ts, open, high, low, close, ...(volume !== undefined ? { volume } : {}) };
}

describe("heikinAshi — calculateHeikinAshi", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(calculateHeikinAshi([]), []);
  });

  it("handles single candle correctly", () => {
    // First candle: HA Open = (O+C)/2, HA Close = (O+H+L+C)/4
    const input = [candle(1000, 100, 110, 90, 105)];
    const result = calculateHeikinAshi(input);
    
    assert.equal(result.length, 1);
    assert.equal(result[0].ts, 1000);
    assert.equal(result[0].open, 102.5); // (100 + 105) / 2
    assert.equal(result[0].close, 101.25); // (100 + 110 + 90 + 105) / 4
    assert.equal(result[0].high, 110); // max(110, 102.5, 101.25)
    assert.equal(result[0].low, 90); // min(90, 102.5, 101.25)
  });

  it("calculates recursive HA Open correctly for multiple candles", () => {
    const input = [
      candle(1000, 100, 110, 90, 105),  // HA: O=102.5, C=101.25
      candle(2000, 105, 115, 100, 110), // HA: O=(102.5+101.25)/2=101.875, C=(105+115+100+110)/4=107.5
      candle(3000, 110, 120, 105, 115), // HA: O=(101.875+107.5)/2=104.6875, C=(110+120+105+115)/4=112.5
    ];
    const result = calculateHeikinAshi(input);
    
    assert.equal(result.length, 3);
    
    // Candle 0
    assert.equal(result[0].open, 102.5);
    assert.equal(result[0].close, 101.25);
    
    // Candle 1 - HA Open = (prev HA Open + prev HA Close) / 2
    assert.equal(result[1].open, 101.875);
    assert.equal(result[1].close, 107.5);
    
    // Candle 2
    assert.equal(result[2].open, 104.6875);
    assert.equal(result[2].close, 112.5);
  });

  it("calculates HA High and HA Low correctly", () => {
    // Case where HA Open/Close extend beyond original H/L
    const input = [
      candle(1000, 100, 102, 98, 101), // HA: O=100.5, C=100.25, High=max(102,100.5,100.25)=102, Low=min(98,100.5,100.25)=98
      candle(2000, 101, 103, 99, 100), // HA: O=(100.5+100.25)/2=100.375, C=(101+103+99+100)/4=100.75
    ];
    const result = calculateHeikinAshi(input);
    
    assert.equal(result[0].high, 102);
    assert.equal(result[0].low, 98);
    
    // Second candle: HA High = max(103, 100.375, 100.75) = 103
    // HA Low = min(99, 100.375, 100.75) = 99
    assert.equal(result[1].high, 103);
    assert.equal(result[1].low, 99);
  });

  it("handles case where HA Open/Close exceed original High/Low", () => {
    // Strong trend candle where HA values extend beyond original range
    const input = [
      candle(1000, 100, 105, 95, 104), // HA: O=102, C=101, High=max(105,102,101)=105, Low=min(95,102,101)=95
      candle(2000, 104, 106, 102, 105), // HA: O=(102+101)/2=101.5, C=(104+106+102+105)/4=104.25
    ];
    const result = calculateHeikinAshi(input);
    
    // First candle HA values within original range
    assert.equal(result[0].high, 105);
    assert.equal(result[0].low, 95);
    
    // Second candle: HA High = max(106, 101.5, 104.25) = 106
    // HA Low = min(102, 101.5, 104.25) = 101.5 (HA Open becomes new low!)
    assert.equal(result[1].high, 106);
    assert.equal(result[1].low, 101.5);
  });

  it("preserves volume when present", () => {
    const input = [candle(1000, 100, 110, 90, 105, 1000)];
    const result = calculateHeikinAshi(input);
    assert.equal(result[0].volume, 1000);
  });

  it("skips invalid candles (non-finite values)", () => {
    const input = [
      candle(1000, 100, 110, 90, 105),
      { ts: 2000, open: NaN, high: 115, low: 100, close: 110 }, // invalid
      candle(3000, 110, 120, 105, 115),
    ];
    const result = calculateHeikinAshi(input);
    assert.equal(result.length, 2); // invalid candle skipped
    assert.equal(result[0].ts, 1000);
    assert.equal(result[1].ts, 3000);
  });

  it("handles null/undefined input gracefully", () => {
    assert.deepEqual(calculateHeikinAshi(null), []);
    assert.deepEqual(calculateHeikinAshi(undefined), []);
  });

  it("does NOT mutate the original candle array (original OHLC protected)", () => {
    const input = [candle(1000, 100, 110, 90, 105), candle(2000, 105, 115, 100, 110)];
    const snapshot = JSON.parse(JSON.stringify(input));
    calculateHeikinAshi(input);
    assert.deepEqual(input, snapshot, "input candles must be byte-identical after transform");
  });

  it("chronological ordering is preserved (ascending ts, same count)", () => {
    const input = [
      candle(3000, 110, 120, 105, 115),
      candle(1000, 100, 110, 90, 105),
      candle(2000, 105, 115, 100, 110),
    ];
    const result = calculateHeikinAshi(input);
    // Output follows INPUT order (caller supplies chronological order; the
    // calculator never re-sorts or drops) — documented contract.
    assert.deepEqual(result.map((c) => c.ts), [3000, 1000, 2000]);
  });

  it("a skipped leading candle still initializes the first valid candle", () => {
    const input = [
      { ts: 500, open: NaN, high: 1, low: 1, close: 1 }, // skipped
      candle(1000, 100, 110, 90, 105),
    ];
    const result = calculateHeikinAshi(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].open, 102.5, "first VALID candle uses (O+C)/2 init");
  });

  it("history prepend (pagination): the chain recomputes from the NEW oldest candle", () => {
    // Simulates "Load More History": older candles are prepended to the loaded
    // window, so every HA open from that point on is re-derived from the
    // extended chain — never patched onto previously-transformed values.
    const base = [candle(2000, 105, 115, 100, 110), candle(3000, 110, 120, 105, 115)];
    const before = calculateHeikinAshi(base);
    const older = [candle(1000, 100, 110, 90, 105)];
    const after = calculateHeikinAshi([...older, ...base]);

    assert.equal(after.length, 3);
    // The previously-first candle's open changes: it now derives from the
    // prepended candle instead of the (O+C)/2 seed.
    assert.equal(before[0].open, 107.5); // (105+110)/2 seed on the old window
    assert.equal(after[1].open, 101.875); // (102.5+101.25)/2 from the older chain
    // Full-chain identity: recomputing over the merged window equals the
    // batch result of that window (no incremental patching anywhere).
    assert.deepEqual(after, calculateHeikinAshi([...older, ...base]));
  });
});

describe("heikinAshi — heikinAshiBar (single-bar primitive)", () => {
  it("first candle (prev=null) seeds open from (O+C)/2", () => {
    const ha = heikinAshiBar(candle(1000, 100, 110, 90, 105, 7), null);
    assert.equal(ha.open, 102.5);
    assert.equal(ha.close, 101.25);
    assert.equal(ha.high, 110);
    assert.equal(ha.low, 90);
    assert.equal(ha.volume, 7);
  });

  it("subsequent candle derives open from the predecessor pair", () => {
    const ha = heikinAshiBar(candle(2000, 105, 115, 100, 110), { open: 102.5, close: 101.25 });
    assert.equal(ha.open, 101.875); // (102.5+101.25)/2
    assert.equal(ha.close, 107.5); // (105+115+100+110)/4
    assert.equal(ha.high, 115);
    assert.equal(ha.low, 100);
  });

  it("HA high/low always envelope open and close", () => {
    const ha = heikinAshiBar(candle(2000, 100, 102, 98, 101), { open: 500, close: 500 });
    assert.equal(ha.open, 500);
    assert.equal(ha.close, 100.25);
    assert.equal(ha.high, 500, "high takes the max envelope");
    assert.equal(ha.low, 98, "low takes the min envelope");
    assert.ok(ha.high >= ha.open && ha.high >= ha.close, "high >= open, close");
    assert.ok(ha.low <= ha.open && ha.low <= ha.close, "low <= open, close");
  });

  it("never mutates the input candle", () => {
    const src = candle(1000, 100, 110, 90, 105, 3);
    const snapshot = JSON.parse(JSON.stringify(src));
    heikinAshiBar(src, null);
    assert.deepEqual(src, snapshot);
  });
});

describe("heikinAshi — updateFormingHeikinAshi", () => {
  it("returns copy when no forming candle", () => {
    const haCandles = [
      { ts: 1000, open: 100, high: 105, low: 95, close: 102 },
      { ts: 2000, open: 101, high: 106, low: 96, close: 103 },
    ];
    const result = updateFormingHeikinAshi(haCandles, null);
    assert.deepEqual(result, haCandles);
    assert.notStrictEqual(result, haCandles); // new array, never mutated input
  });

  it("appends forming candle when timestamp is newer (recursive open from last HA pair)", () => {
    const haCandles = [
      { ts: 1000, open: 100, high: 105, low: 95, close: 102 },
      { ts: 2000, open: 101, high: 106, low: 96, close: 103 },
    ];
    const forming = candle(3000, 103, 108, 100, 105);
    const result = updateFormingHeikinAshi(haCandles, forming);

    assert.equal(result.length, 3);
    assert.equal(result[2].ts, 3000);
    // HA Open = (101 + 103) / 2 = 102 ; HA Close = (103+108+100+105)/4 = 104
    assert.equal(result[2].open, 102);
    assert.equal(result[2].close, 104);
    assert.equal(result[2].high, 108); // max(108, 102, 104)
    assert.equal(result[2].low, 100); // min(100, 102, 104)
  });

  it("replaces the last candle when the forming bucket ts matches (repeat updates never recurse)", () => {
    const haCandles = [
      { ts: 1000, open: 100, high: 105, low: 95, close: 102 },
      { ts: 2000, open: 101, high: 106, low: 96, close: 103 },
    ];
    // Update 1 — same ts as last HA candle
    const u1 = updateFormingHeikinAshi(haCandles, candle(2000, 103, 108, 100, 105));
    assert.equal(u1.length, 2, "replaced, not appended");
    assert.equal(u1[1].open, 101, "open derives from the PRECEDING candle (100+102)/2");
    assert.equal(u1[1].close, 104);

    // Update 2 — repeated updates on the same bucket keep stable open (no drift)
    const u2 = updateFormingHeikinAshi(u1, candle(2000, 103, 109, 99, 108));
    assert.equal(u2.length, 2);
    assert.equal(u2[1].open, 101, "open unchanged across repeated same-bucket updates");
    assert.equal(u2[1].close, 104.75); // (103+109+99+108)/4

    // Update 3 — further ticks still stable
    const u3 = updateFormingHeikinAshi(u2, candle(2000, 103, 110, 98, 106));
    assert.equal(u3.length, 2);
    assert.equal(u3[1].open, 101);
    assert.equal(u3[1].close, 104.25);
  });

  it("handles first forming candle when no history exists", () => {
    const result = updateFormingHeikinAshi([], candle(1000, 100, 110, 90, 105));
    assert.equal(result.length, 1);
    assert.equal(result[0].open, 102.5); // first-candle (O+C)/2 init
    assert.equal(result[0].close, 101.25);
  });
});

// ── Persistence (aura.candleType.v1) ──────────────────────────────────────────

describe("heikinAshi — persistence", () => {
  it("sanitizeCandleType validates the two known values", () => {
    assert.equal(sanitizeCandleType("candles"), "candles");
    assert.equal(sanitizeCandleType("heikin-ashi"), "heikin-ashi");
  });

  it("sanitizeCandleType falls back to candles for unknown/corrupted values", () => {
    assert.equal(sanitizeCandleType("invalid"), "candles");
    assert.equal(sanitizeCandleType(""), "candles");
    assert.equal(sanitizeCandleType(123), "candles");
    assert.equal(sanitizeCandleType(null), "candles");
    assert.equal(sanitizeCandleType(undefined), "candles");
    assert.equal(sanitizeCandleType({}), "candles");
  });

  it("loadCandleType reads a stored value from the versioned key", () => {
    const storage = {
      getItem: (key) => (key === "aura.candleType.v1" ? "heikin-ashi" : null),
    };
    assert.equal(loadCandleType(storage), "heikin-ashi");
  });

  it("loadCandleType falls back to candles on missing or corrupted storage", () => {
    assert.equal(loadCandleType({ getItem: () => null }), "candles");
    assert.equal(loadCandleType({ getItem: () => "bogus" }), "candles");
    assert.equal(
      loadCandleType({ getItem: () => { throw new Error("denied"); } }),
      "candles",
      "storage failure (private mode) must never throw",
    );
  });

  it("saveCandleType round-trips through storage", () => {
    const store = new Map();
    const storage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    };
    saveCandleType("heikin-ashi", storage);
    assert.equal(store.get("aura.candleType.v1"), "heikin-ashi");
    assert.equal(loadCandleType(storage), "heikin-ashi");
  });

  it("saveCandleType sanitizes before writing (never persists junk)", () => {
    const store = new Map();
    const storage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    };
    saveCandleType("bogus", storage);
    assert.equal(store.get("aura.candleType.v1"), "candles");
  });

  it("saveCandleType survives throwing storage (private mode)", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error("denied"); },
    };
    // must not throw
    saveCandleType("heikin-ashi", storage);
  });
});

describe("heikinAshi — constants", () => {
  it("VALID_CANDLE_TYPES contains both types in canonical order", () => {
    assert.deepEqual(VALID_CANDLE_TYPES, ["candles", "heikin-ashi"]);
  });

  it("CANDLE_TYPE_LABELS has correct display labels", () => {
    assert.equal(CANDLE_TYPE_LABELS.candles, "Candles");
    assert.equal(CANDLE_TYPE_LABELS["heikin-ashi"], "Heikin Ashi");
  });

  it("DEFAULT_CANDLE_TYPE is candles (existing users keep the current experience)", () => {
    assert.equal(DEFAULT_CANDLE_TYPE, "candles");
  });

  it("CANDLE_TYPE_STORAGE_KEY is versioned per AURA conventions", () => {
    assert.equal(CANDLE_TYPE_STORAGE_KEY, "aura.candleType.v1");
  });
});