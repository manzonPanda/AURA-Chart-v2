/**
 * IG dealing-hours verification — read-only GET /markets/{epic} against the
 * LIVE account. The AUTHORITATIVE source for an instrument's market calendar
 * (openingHours / closingHours) and quoting precision (currency + a live
 * snapshot quote), exactly what backend/src/market/calendar.ts and
 * instruments.ts must encode. Phase 0 (multi-instrument) verification tool.
 *
 *   npm run ig:market-check                              # configured DAX + GOLD
 *   npm run ig:market-check -- --epic=IX.D.DAX.IGM.IP    # any EPIC(s), repeatable
 *
 * Prints ONLY non-secret fields. No orders, no /prices history (zero
 * historical-allowance consumption), no database access.
 */
import "dotenv/config";
import { isConfigured, loadConfig } from "../config.js";
import { IgClient } from "../ig/client.js";
import { getIGMarketDetails } from "../ig/market.js";

function parseArgs(): string[] {
  const epics: string[] = [];
  for (const raw of process.argv.slice(2)) {
    const [key, ...rest] = raw.replace(/^--/, "").split("=");
    const val = rest.join("=");
    if (key === "epic" && val.trim()) epics.push(val.trim());
    else {
      console.error(`market-hours-check: unknown argument --${key} (use --epic=EPIC, repeatable)`);
      process.exit(1);
    }
  }
  if (epics.length === 0) {
    const config = loadConfig();
    for (const epic of [config.ig.defaultEpic, config.ig.goldEpic]) {
      if (epic) epics.push(epic);
    }
  }
  return epics;
}

/** Pick a field out of a loosely-typed IG payload without assuming shape. */
function pick(obj: unknown, key: string): unknown {
  if (obj && typeof obj === "object" && key in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

function printInstrument(epic: string, details: Awaited<ReturnType<typeof getIGMarketDetails>>): void {
  const instrument = details.instrument ?? {};
  const market = details.market ?? {};
  const snapshot = details.snapshot ?? {};
  const keys = (o: unknown): string => (o && typeof o === "object" ? Object.keys(o).sort().join(", ") : "(none)");

  console.log(`\n──────── ${epic} ────────`);
  console.log(`name               : ${JSON.stringify(pick(instrument, "name") ?? pick(market, "instrumentName"))}`);
  console.log(`type               : ${JSON.stringify(pick(instrument, "type"))}`);
  console.log(`currencies         : ${JSON.stringify(pick(instrument, "currencies"))}`);
  console.log(`onePipMeans        : ${JSON.stringify(pick(instrument, "onePipMeans"))}`);
  console.log(`valueOfOnePip      : ${JSON.stringify(pick(instrument, "valueOfOnePip"))}`);
  console.log(`unit / lotSize     : ${JSON.stringify(pick(instrument, "unit"))} / ${JSON.stringify(pick(instrument, "lotSize"))}`);
  console.log(`marketStatus       : ${JSON.stringify(pick(market, "marketStatus"))}`);
  console.log(`timezoneOffset     : ${JSON.stringify(pick(market, "timezoneOffset"))}`);
  console.log(`decimalPlacesFactor: ${JSON.stringify(pick(instrument, "decimalPlacesFactor") ?? pick(market, "decimalPlacesFactor"))}`);
  console.log(`openingHours       : ${JSON.stringify(pick(instrument, "openingHours"))}`);
  console.log(`closingHours       : ${JSON.stringify(pick(instrument, "closingHours"))}`);
  console.log(`snapshot quote     : bid=${JSON.stringify(pick(snapshot, "bid"))} offer=${JSON.stringify(pick(snapshot, "offer"))} (quoting-precision hint)`);
  console.log(`instrument keys    : ${keys(instrument)}`);
  console.log(`market keys        : ${keys(market)}`);
}

async function main(): Promise<void> {
  const epics = parseArgs();
  if (epics.length === 0) {
    console.error("market-hours-check: no EPIC — set IG_DAX_EPIC / IG_GOLD_EPIC or pass --epic=EPIC");
    process.exit(1);
  }
  const config = loadConfig();
  if (!isConfigured(config)) {
    console.error("market-hours-check: IG credentials missing — set IG_API_KEY / IG_USERNAME / IG_PASSWORD in backend/.env");
    process.exit(1);
  }
  const ig = new IgClient({
    apiKey: config.ig.apiKey,
    username: config.ig.username,
    password: config.ig.password,
    accountId: config.ig.accountId,
    baseUrl: config.ig.baseUrl,
    sessionVersion: config.ig.sessionVersion,
    sendEncryptFlag: config.ig.sendEncryptFlag,
  });

  let failures = 0;
  for (const epic of epics) {
    try {
      const details = await getIGMarketDetails(ig, epic);
      printInstrument(epic, details);
      // v3 of /markets/{epic} additionally carries marketStatus, snapshot
      // marketState and (sometimes) populated openingHours/closingHours.
      const v3 = await ig.request<Record<string, unknown>>(`/markets/${encodeURIComponent(epic)}`, { version: "3" });
      console.log(`── v3 supplement ──`);
      console.log(`marketStatus        : ${JSON.stringify(pick(v3.market, "marketStatus"))}`);
      console.log(`snapshot.marketState: ${JSON.stringify(pick(v3.snapshot, "marketState"))}`);
      console.log(`v3 openingHours     : ${JSON.stringify(pick(v3.instrument, "openingHours"))}`);
      console.log(`v3 closingHours     : ${JSON.stringify(pick(v3.instrument, "closingHours"))}`);
    } catch (err) {
      failures += 1;
      console.error(`\n──────── ${epic} ────────\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures > 0) process.exit(1);
}

void main();
