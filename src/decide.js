// Pure, I/O-free decision primitives — no readline, no HTTP. Both the CLI
// (approve.js) and the web UI (server.js) build a line the same way,
// through the same code, so "what does an approved line look like" has
// exactly one answer regardless of which surface asked the question.
import { catalogue } from "./catalogue.js";
import { reconcileUnit } from "./units.js";
import { checkStock } from "./stock.js";

const skuByCode = new Map(catalogue.map((s) => [s.sku_code, s]));

export function approvedLine(r, candidate, reason, requestedQty) {
  const sku = skuByCode.get(candidate.sku_code);
  const unitCheck = reconcileUnit(r.unit, sku?.uom);
  const stock = checkStock(candidate.sku_code, r.quantity);

  return {
    raw_text: r.raw_text,
    quantity: r.quantity,
    ...(requestedQty !== undefined && requestedQty !== r.quantity ? { requested_qty: requestedQty } : {}),
    unit: r.unit,
    resolved_unit: unitCheck.resolvedUnit,
    catalogue_uom: sku?.uom ?? null,
    unit_ok: unitCheck.ok,
    unit_note: unitCheck.note,
    sku_code: candidate.sku_code,
    product: candidate.label,
    stock_status: stock.status,
    stock_available: stock.available,
    stock_short_by: stock.short_by,
    status: "approved",
    reason,
  };
}

export function skippedLine(r, reason) {
  return {
    raw_text: r.raw_text,
    quantity: r.quantity,
    unit: r.unit,
    sku_code: null,
    product: null,
    status: "skipped",
    reason,
  };
}

export function backorderedLine(r, candidate, quantity, requestedQty, eta) {
  return {
    raw_text: r.raw_text,
    quantity,
    unit: r.unit,
    sku_code: candidate.sku_code,
    product: candidate.label,
    requested_qty: requestedQty,
    status: "backordered",
    eta: eta || "unspecified",
    reason: "split fulfilment — remainder backordered",
  };
}

export function manualNoteLine(r, note) {
  return {
    raw_text: r.raw_text,
    quantity: r.quantity,
    unit: r.unit,
    sku_code: null,
    product: null,
    status: "manual_note",
    note,
  };
}
