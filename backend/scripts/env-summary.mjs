/** Prints a MASKED summary of IG configuration — never outputs secrets. */
import fs from "node:fs";

const rows = [];
let epic = "";
let gold = "";
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^(IG_[A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  const k = m[1];
  const v = m[2].trim();
  if (/^(PASSWORD|USERNAME|API_KEY|ACCOUNT_ID)$/.test(k.slice(3))) {
    rows.push(`${k.padEnd(16)} <set:${v.length}ch>${/@/.test(v) && k === "IG_USERNAME" ? " (email)" : ""}`);
  } else {
    rows.push(`${k.padEnd(16)} ${v || "(empty)"}`);
    if (k === "IG_DAX_EPIC") epic = v;
    if (k === "IG_GOLD_EPIC") gold = v;
  }
}
console.log(rows.join("\n"));
console.log(`\ndaxEpicSet : ${Boolean(epic)}`);
console.log(`goldEpicSet: ${Boolean(gold)}`);
