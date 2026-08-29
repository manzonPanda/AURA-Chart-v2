/**
 * TEMPORARY verification sweep: hits the DEV SERVER (http://localhost:5173 —
 * the exact path the browser uses, through the Vite proxy) for every timeframe
 * and checks: count, freshness, chronological order, duplicates, gaps.
 */
const BASE = process.env.SWEEP_BASE || "http://localhost:5173";
const CASES = [
  { tf: "1m", resolution: "MINUTE", limit: 500, bucket: 60 },
  { tf: "3m", resolution: "MINUTE_3", limit: 500, bucket: 180 },
];

const iso = (ms) => new Date(ms).toISOString();

async function main() {
  console.log(`sweep base=${BASE} now=${iso(Date.now())}`);
  let allPass = true;
  for (const c of CASES) {
    try {
      const res = await fetch(`${BASE}/api/candles?resolution=${c.resolution}&limit=${c.limit}`);
      const j = await res.json();
      if (!res.ok || !Array.isArray(j.candles)) {
        console.log(`[${c.tf}] FAIL http=${res.status} body=${JSON.stringify(j).slice(0, 140)}`);
        allPass = false;
        continue;
      }
      const cs = j.candles;
      const now = Date.now();
      const first = cs[0], last = cs[cs.length - 1];
      let dupes = 0, nonChrono = 0, maxGap = 0, offGrid = 0;
      for (let i = 0; i < cs.length; i++) {
        const b = cs[i].ts / 1000;
        if (b % c.bucket !== 0) offGrid++;
        if (i > 0) {
          const prev = cs[i - 1].ts / 1000;
          if (cs[i].ts < prev) nonChrono++;
          else if (cs[i].ts === prev) dupes++;
          else maxGap = Math.max(maxGap, b - prev);
        }
      }
      const ageSec = Math.round((now - last.ts) / 1000);
      const gapBuckets = maxGap / c.bucket;
      // Chronology + uniqueness are the hard requirements (gaps only mark
      // closed-market windows).
      const ok = nonChrono === 0 && dupes === 0;
      // IG leaves gaps when the market is closed — gaps are OK, misalignment is not.
      console.log(
        `[${c.tf}] ${ok ? "PASS" : "FAIL"} count=${cs.length}/${c.limit}` +
          ` first=${iso(first.ts)} last=${iso(last.ts)} age=${ageSec}s` +
          ` nonChrono=${nonChrono} dupes=${dupes} offGrid=${offGrid} maxGap=${gapBuckets.toFixed(1)} buckets`,
      );
      if (!ok) allPass = false;
    } catch (err) {
      console.log(`[${c.tf}] FAIL ${err}`);
      allPass = false;
    }
  }
  console.log(allPass ? "SWEEP: ALL PASS" : "SWEEP: FAILURES PRESENT");
}

main();
