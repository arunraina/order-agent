// Line and order totals from the catalogue's own unit_price/gst_rate/hsn
// fields. Prices here are illustrative sample data, exactly like
// stock_qty — swap in a real price list before this touches a real quote.
import { catalogue } from "./catalogue.js";

const skuByCode = new Map(catalogue.map((s) => [s.sku_code, s]));

const round2 = (n) => Number(n.toFixed(2));

export function priceLine(skuCode, quantity) {
  const sku = skuByCode.get(skuCode);
  if (!sku || sku.unit_price == null) {
    return { ok: false, reason: "no price on file for this SKU" };
  }
  const subtotal = round2(sku.unit_price * quantity);
  const gstAmount = round2(subtotal * (sku.gst_rate / 100));
  return {
    ok: true,
    unit_price: sku.unit_price,
    hsn: sku.hsn,
    gst_rate: sku.gst_rate,
    subtotal,
    gst_amount: gstAmount,
    total: round2(subtotal + gstAmount),
  };
}

// Prices every approved/backordered line in a confirmed draft and rolls
// them up into two totals — what's payable now vs. what's pending on the
// backordered portion — rather than one blended number that hides which
// part of the order actually ships today.
export function priceOrder(lines) {
  const priced = lines.map((l) => {
    if (l.status !== "approved" && l.status !== "backordered") {
      return { ...l, pricing: null };
    }
    const p = priceLine(l.sku_code, l.quantity);
    return { ...l, pricing: p.ok ? p : null };
  });

  const empty = () => ({ subtotal: 0, gst: 0, total: 0 });
  const totals = { now: empty(), backordered: empty() };

  for (const l of priced) {
    if (!l.pricing) continue;
    const bucket = l.status === "backordered" ? totals.backordered : totals.now;
    bucket.subtotal += l.pricing.subtotal;
    bucket.gst += l.pricing.gst_amount;
    bucket.total += l.pricing.total;
  }

  const round = (o) => ({ subtotal: round2(o.subtotal), gst: round2(o.gst), total: round2(o.total) });
  return { lines: priced, totals: { now: round(totals.now), backordered: round(totals.backordered) } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = JSON.parse(
    (await import("fs")).readFileSync(new URL("../data/sample-lines.json", import.meta.url))
  );
  // Pretend every sample line resolved to its top-scored SKU, approved in full —
  // this is a standalone smoke test of the pricing math, not a real order.
  const { findCandidates } = await import("./match.js");
  const asApproved = lines
    .map((l) => ({ line: l, match: findCandidates(l) }))
    .filter((x) => x.match.candidates[0])
    .map((x) => ({
      raw_text: x.line.raw_text,
      quantity: x.line.quantity,
      sku_code: x.match.candidates[0].sku_code,
      status: "approved",
    }));

  const { lines: priced, totals } = priceOrder(asApproved);
  for (const l of priced) {
    console.log(`${l.raw_text.padEnd(28)} qty ${String(l.quantity).padEnd(6)} ${l.pricing ? `₹${l.pricing.total}` : "no price"}`);
  }
  console.log("\nTotals (now):", totals.now);
}
