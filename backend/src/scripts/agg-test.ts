/** TEMPORARY offline unit test for the 3m aggregation (no IG calls). */
import { aggregateToMinutes } from "../ig/historical.js";

const U = (h: number, m: number) => Date.UTC(2026, 0, 28, h, m);
const mk = (ts: number, o: number, c: number, v: number) => ({
  ts, open: o, high: o + 1, low: o - 1, close: c, volume: v,
});

const one = [
  mk(U(10, 0), 100, 101, 1),
  mk(U(10, 1), 101, 102, 2),
  mk(U(10, 2), 102, 103, 3),
  mk(U(10, 3), 103, 104, 4),
  mk(U(10, 4), 104, 105, 5),
  mk(U(10, 5), 105, 106, 6),
  mk(U(10, 8), 108, 109, 9),
];

const three = aggregateToMinutes(one, 3);
for (const c of three) {
  console.log(new Date(c.ts).toISOString(), `O${c.open} H${c.high} L${c.low} C${c.close} V${c.volume ?? 0}`);
}

const buckets = three.map((b) => b.ts);
const ok =
  three.length === 3 &&
  U(10, 0) === buckets[0] &&
  U(10, 3) === buckets[1] &&
  U(10, 6) === buckets[2] &&
  // example semantics from the spec: 10:00+10:01+10:02 -> 10:00; 10:03/04/05 -> 10:03
  three[0].open === 100 && three[0].high === 103 && three[0].low === 99 && three[0].close === 103 && (three[0].volume ?? 0) === 6 &&
  three[1].open === 103 && three[1].high === 106 && three[1].low === 102 && three[1].close === 106 && (three[1].volume ?? 0) === 15 &&
  deadline(buckets);

function deadline(list: number[]): boolean {
  return list.every((b) => b % 180000 === 0);
}

console.log(ok ? "AGGREGATION PASS" : "AGGREGATION FAIL", JSON.stringify(buckets.map((b) => new Date(b).toISOString())));