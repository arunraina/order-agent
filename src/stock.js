import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { catalogue } from "./catalogue.js";

const skuByCode = new Map(catalogue.map((s) => [s.sku_code, s]));

// Live stock lives separately from the catalogue on purpose — this
// mirrors the canonical-entity split the Griffy Supply design already
// settled on (MaterialMaster vs StockSnapshot as different things that
// change at different rates and from different sources). sku-master.json
// is the static product definition; this file is the "Manual" tier from
// that design — a distributor toggling their own number in-app — and it
// always wins over whatever baseline stock_qty the catalogue carries.
const OVERRIDES_PATH = new URL("../data/stock-overrides.json", import.meta.url);

function loadOverrides() {
  if (!existsSync(OVERRIDES_PATH)) return {};
  try {
    return JSON.parse(readFileSync(OVERRIDES_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveOverrides(overrides) {
  mkdirSync(new URL(".", OVERRIDES_PATH), { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

function effectiveStockQty(skuCode) {
  const overrides = loadOverrides();
  const override = overrides[skuCode];
  if (override && typeof override.qty === "number") return override.qty;
  return skuByCode.get(skuCode)?.stock_qty ?? null;
}

// The one write path for stock in this whole app — still local to this
// process's data files, never a real ERP, but it's a real write with a
// real timestamp, not sample data pretending to update.
export function setStock(skuCode, qty, updatedBy = "manual") {
  if (!skuByCode.has(skuCode)) throw new Error(`Unknown SKU: ${skuCode}`);
  const overrides = loadOverrides();
  overrides[skuCode] = { qty, updated_at: new Date().toISOString(), updated_by: updatedBy };
  saveOverrides(overrides);
  return overrides[skuCode];
}

export function listStock() {
  const overrides = loadOverrides();
  return catalogue.map((sku) => ({
    sku_code: sku.sku_code,
    label: `${sku.brand} ${sku.product}`,
    uom: sku.uom,
    qty: effectiveStockQty(sku.sku_code),
    source: overrides[sku.sku_code] ? "manual_override" : "catalogue_baseline",
    updated_at: overrides[sku.sku_code]?.updated_at ?? null,
  }));
}

export function checkStock(skuCode, requestedQty) {
  const sku = skuByCode.get(skuCode);
  if (!sku) return { status: "unknown_sku", available: null, short_by: null };

  const available = effectiveStockQty(skuCode);
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
