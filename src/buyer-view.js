// Pure transforms from persisted (operator-shaped) order state to what a
// buyer is allowed to see. Kept separate from server.js — same reason
// decide.js is separate — so "what does the buyer see" has one answer and
// can be tested without a live server or database.

export const STATUS_LABEL = {
  submitted: "Submitted",
  in_review: "Being reviewed",
  confirmed: "Confirmed",
  partially_confirmed: "Partially confirmed",
  cancelled: "Cancelled",
};

export function stockBand(stock) {
  if (!stock) return null;
  if (stock.status === "in_stock") return "in_stock";
  if (stock.status === "insufficient") return "limited";
  if (stock.status === "out_of_stock") return "out_of_stock";
  return null; // unknown_sku / unknown_stock — nothing honest to show
}

// The buyer never sees a score, a sku_code, or the raw candidate list —
// only a product name, a stock band, and (for an unresolved ambiguous line)
// label-only options addressed by array position. The client sends that
// position back, never a sku_code, so nothing buyer-supplied can pick a
// SKU outside what findCandidates() actually returned for this line.
export function toBuyerLine(line) {
  const candidates = line.candidates || [];

  if (line.status === "manual_note") {
    return {
      id: line.id, raw_text: line.raw_text, quantity: line.quantity, unit: line.unit,
      state: "noted", note: line.note,
    };
  }

  const chosen = line.chosen_sku_code
    ? candidates.find((c) => c.sku_code === line.chosen_sku_code)
    : null;
  if (chosen) {
    return {
      id: line.id, raw_text: line.raw_text, quantity: line.quantity, unit: line.unit,
      state: "resolved", product_name: chosen.label, stock_band: stockBand(chosen.stock),
    };
  }

  if (line.verdict === "no_match") {
    return {
      id: line.id, raw_text: line.raw_text, quantity: line.quantity, unit: line.unit,
      state: "no_match",
    };
  }

  return {
    id: line.id, raw_text: line.raw_text, quantity: line.quantity, unit: line.unit,
    state: "needs_clarification",
    options: candidates.map((c, index) => ({ index, label: c.label })),
  };
}

export function toBuyerOrder(order) {
  return {
    id: order.id, status: order.status, status_label: STATUS_LABEL[order.status] || order.status,
    buyer_name: order.buyer_name, order_text: order.order_text, created_at: order.created_at,
  };
}
