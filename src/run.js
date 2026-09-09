import { readFileSync } from "fs";
import { extract } from "./extract.js";
import { findCandidates } from "./match.js";

export async function processOrder(orderText) {
  const { lines, notes } = await extract(orderText);
  const results = lines.map((line) => ({
    ...findCandidates(line),
    quantity: line.quantity,
    unit: line.unit,
    missing: line.missing ?? [],
  }));

  const counts = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});

  return { notes, counts, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const orders = JSON.parse(
    readFileSync(new URL("../data/sample-orders.json", import.meta.url))
  );
  const out = await processOrder(orders[Number(process.argv[2] ?? 0)]);
  console.log("\nVERDICTS:", out.counts, "\n");
  for (const r of out.results) {
    console.log(`"${r.raw_text}"  ${r.quantity} ${r.unit}  →  ${r.verdict}`);
    console.log("   top:", r.candidates[0]?.label ?? "—", r.candidates[0]?.score ?? "");
  }
}
