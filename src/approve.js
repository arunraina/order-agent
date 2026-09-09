import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { processOrder } from "./run.js";
import { checkStock, describeStock } from "./stock.js";
import { approvedLine, skippedLine, backorderedLine } from "./decide.js";
import { priceOrder } from "./pricing.js";

// Walks a human through every extracted line and asks what to do with it.
// This is the actual governance boundary: everything upstream (extract,
// match) only ever proposes. Nothing becomes a "line on a PO" until a
// person here says so — matched still needs a yes, ambiguous needs a pick,
// no_match needs a manual call. `ask` is injected so this is testable with
// scripted answers instead of real stdin.
export async function approveResults(results, ask) {
  const approved = [];

  for (const r of results) {
    if (r.verdict === "matched") {
      const top = r.candidates[0];
      approved.push(...(await resolveMatch(r, top, "auto-matched, human-approved", ask)));
    } else if (r.verdict === "ambiguous") {
      const list = r.candidates
        .map((c, i) => `    ${i + 1}. ${c.label}  (score ${c.score})  [${describeStock(c.sku_code, r.quantity)}]`)
        .join("\n");
      const ans = (
        await ask(
          `AMBIGUOUS  "${r.raw_text}"\n${list}\n  Pick a number, or 's' to skip: `
        )
      ).trim();
      const idx = Number(ans) - 1;

      if (Number.isInteger(idx) && r.candidates[idx]) {
        approved.push(...(await resolveMatch(r, r.candidates[idx], "human-resolved ambiguity", ask)));
      } else {
        approved.push(skippedLine(r, "left unresolved by reviewer"));
      }
    } else {
      const ans = await ask(
        `NO_MATCH  "${r.raw_text}"\n  No catalogue candidate. Add a note, or press enter to skip: `
      );
      approved.push(
        ans.trim()
          ? {
              raw_text: r.raw_text,
              quantity: r.quantity,
              unit: r.unit,
              sku_code: null,
              product: null,
              status: "manual_note",
              note: ans.trim(),
            }
          : skippedLine(r, "left unresolved by reviewer")
      );
    }
  }

  return approved;
}

// Sufficient stock is a plain yes/no. Insufficient stock is a real business
// decision with three honest shapes, not one — approving the full quantity
// anyway is a promise the distributor may not be able to keep; a silent
// partial is a promise nobody stated; a split with an ETA is the only one
// of the three that says what will actually happen and when.
async function resolveMatch(r, candidate, baseReason, ask) {
  const stock = checkStock(candidate.sku_code, r.quantity);

  if (stock.status !== "insufficient") {
    const label = candidate.label;
    const score = candidate.score !== undefined ? `  (score ${candidate.score})` : "";
    const ans = (
      await ask(
        `MATCHED  "${r.raw_text}"  ->  ${label}${score}  [${describeStock(candidate.sku_code, r.quantity)}]\n  Approve? [Y/n/skip]: `
      )
    ).trim().toLowerCase();

    if (ans === "" || ans === "y") return [approvedLine(r, candidate, baseReason)];
    if (ans === "skip" || ans === "s") return [skippedLine(r, "skipped by reviewer")];
    return [skippedLine(r, "rejected by reviewer")];
  }

  const ans = (
    await ask(
      `MATCHED  "${r.raw_text}"  ->  ${candidate.label}\n` +
        `  Only ${stock.available} in stock, short by ${stock.short_by}.\n` +
        `    [P] Partial now (${stock.available}), drop the rest\n` +
        `    [B] Split: ${stock.available} now + ${stock.short_by} backordered with an ETA\n` +
        `    [Y] Approve full ${r.quantity} anyway (assume restock before shipment)\n` +
        `    [n] Skip\n` +
        `  Choice: `
    )
  ).trim().toLowerCase();

  if (ans === "p") {
    return [
      approvedLine(
        { ...r, quantity: stock.available },
        candidate,
        "partial fulfilment — remainder dropped",
        r.quantity
      ),
    ];
  }

  if (ans === "b") {
    const eta = (
      await ask(`    When will the remaining ${stock.short_by} arrive? (e.g. "3 days", a date): `)
    ).trim();
    const nowLine = approvedLine(
      { ...r, quantity: stock.available },
      candidate,
      "split fulfilment — immediate portion",
      r.quantity
    );
    const laterLine = backorderedLine(r, candidate, stock.short_by, r.quantity, eta);
    return [nowLine, laterLine];
  }

  if (ans === "y") {
    return [approvedLine(r, candidate, "auto-matched, human-approved despite shortage")];
  }

  return [skippedLine(r, "skipped by reviewer")];
}

export async function reviewOrder(orderText) {
  const { notes, counts, results } = await processOrder(orderText);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\nOrder notes: ${notes}`);
  console.log("Verdict counts:", counts, "\n");

  // Repeated rl.question() calls race against piped (non-TTY) stdin in
  // Node — the process can exit with an "unsettled top-level await"
  // before every prompt is answered. Pulling from the interface's own
  // async iterator instead is the documented-safe way to read one line
  // at a time, and it works the same whether stdin is a real terminal
  // or a pipe (which is how this gets tested without a human typing).
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    return done ? "" : value;
  };

  const approved = await approveResults(results, ask);
  rl.close();

  const { lines: pricedLines, totals } = priceOrder(approved);

  // Still just a draft file, never a real order write — the same
  // "propose, don't write" boundary the whole pipeline is built on.
  const draft = {
    created_at: new Date().toISOString(),
    source_text: orderText,
    lines: pricedLines,
    totals,
    status: "draft_reviewed",
  };

  const dir = new URL("../data/confirmed-orders/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const outPath = new URL(`${Date.now()}.json`, dir);
  writeFileSync(outPath, JSON.stringify(draft, null, 2));
  console.log(`\nDraft PO written: ${outPath.pathname}`);
  console.log(
    `Payable now: ₹${totals.now.total}  (subtotal ₹${totals.now.subtotal} + GST ₹${totals.now.gst})`
  );
  if (totals.backordered.total > 0) {
    console.log(
      `Pending on backorder: ₹${totals.backordered.total}  (subtotal ₹${totals.backordered.subtotal} + GST ₹${totals.backordered.gst})`
    );
  }

  return draft;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const orders = JSON.parse(
    readFileSync(new URL("../data/sample-orders.json", import.meta.url))
  );
  const which = Number(process.argv[2] ?? 0);
  await reviewOrder(orders[which]);
}
