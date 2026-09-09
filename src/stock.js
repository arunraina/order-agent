import { catalogue } from "./catalogue.js";

const skuByCode = new Map(catalogue.map((s) => [s.sku_code, s]));

// A distributor's stock number is only ever as fresh as the last count —
// this stands in for whatever a real ERP poll would return, the same
// "Connected / Lite / Manual" honesty the Griffy Supply catalogue design
// runs on: never promise more certainty than the data actually has. If a
// SKU has no stock_qty at all, that's a distinct case from zero — it
// means nobody has told this system what's on the shelf yet.
export function checkStock(skuCode, requestedQty) {
  const sku = skuByCode.get(skuCode);
  if (!sku) return { status: "unknown_sku", available: null, short_by: null };

  const available = sku.stock_qty;
  if (available == null) return { status: "unknown_stock", available: null, short_by: null };
  if (available <= 0) return { status: "out_of_stock", available, short_by: requestedQty ?? null };

  if (requestedQty != null && available < requestedQty) {
    return {
      status: "insufficient",
      available,
      short_by: Number((requestedQty - available).toFixed(2)),
    };
  }

  return { status: "in_stock", available, short_by: 0 };
}

export function describeStock(skuCode, requestedQty) {
  const r = checkStock(skuCode, requestedQty);
  switch (r.status) {
    case "unknown_sku":
      return "unknown SKU";
    case "unknown_stock":
      return "no stock data";
    case "out_of_stock":
      return "OUT OF STOCK";
    case "insufficient":
      return `only ${r.available} in stock — short by ${r.short_by}`;
    case "in_stock":
      return `${r.available} in stock`;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const sku of catalogue) {
    console.log(`${sku.sku_code.padEnd(22)} ${describeStock(sku.sku_code, null)}`);
  }
}
