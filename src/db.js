import { createClient } from "@supabase/supabase-js";

// order-agent's tables live in their own Postgres schema (order_agent, not
// public) inside a shared Supabase project, so this module always talks to
// that schema explicitly rather than relying on a default search_path.
let client = null;
function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env — see .env.example"
    );
  }
  if (!client) {
    client = createClient(url, key, {
      db: { schema: "order_agent" },
      auth: { persistSession: false },
    });
  }
  return client;
}

const byLineIndex = (a, b) => a.line_index - b.line_index;

function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// Persists the read-only extract+match output (processHandler's shape —
// see server.js) as one order plus one line per result. A "matched" line
// already has its answer, so it's stored pre-resolved; "ambiguous" and
// "no_match" lines start pending, waiting on the buyer or the operator.
export async function createOrder({ orderText, buyerName, buyerPhone, results }) {
  const supabase = db();

  const order = unwrap(
    await supabase
      .from("orders")
      .insert({
        order_text: orderText,
        buyer_name: buyerName || null,
        buyer_phone: buyerPhone || null,
      })
      .select()
      .single()
  );

  const rows = results.map((r, i) => ({
    order_id: order.id,
    line_index: i,
    raw_text: r.raw_text,
    quantity: r.quantity ?? null,
    unit: r.unit ?? null,
    verdict: r.verdict,
    candidates: r.candidates ?? [],
    chosen_sku_code: r.verdict === "matched" ? r.candidates?.[0]?.sku_code ?? null : null,
    status: r.verdict === "matched" ? "resolved" : "pending",
  }));

  const lines = rows.length
    ? unwrap(await supabase.from("order_lines").insert(rows).select())
    : [];

  await recordDecision({
    orderId: order.id,
    orderLineId: null,
    actor: "system",
    action: "order_submitted",
    payload: { line_count: lines.length },
  });

  return { order, lines: lines.sort(byLineIndex) };
}

export async function getOrder(orderId) {
  const supabase = db();
  const order = unwrap(
    await supabase.from("orders").select().eq("id", orderId).single()
  );
  const lines = unwrap(
    await supabase.from("order_lines").select().eq("order_id", orderId)
  );
  return { order, lines: lines.sort(byLineIndex) };
}

// Newest first, for the operator's order list (commit 4).
export async function listOrders({ limit = 50 } = {}) {
  const supabase = db();
  return unwrap(
    await supabase
      .from("orders")
      .select()
      .order("created_at", { ascending: false })
      .limit(limit)
  );
}

// The buyer resolving an "ambiguous" line by picking one of the candidates
// findCandidates() returned. Recorded as its own decision — this is a real
// choice with a real actor, not implicit like a "matched" line's pre-fill.
export async function chooseCandidate({ orderId, lineId, skuCode, actor = "buyer" }) {
  const supabase = db();
  const line = unwrap(
    await supabase
      .from("order_lines")
      .update({ chosen_sku_code: skuCode, status: "resolved", updated_at: new Date().toISOString() })
      .eq("id", lineId)
      .eq("order_id", orderId)
      .select()
      .single()
  );
  await recordDecision({
    orderId,
    orderLineId: lineId,
    actor,
    action: "select_candidate",
    payload: { sku_code: skuCode },
  });
  return line;
}

// One operator action on one line — approve_full / partial / split / skip /
// manual_note — mirroring the decision shapes server.js's confirmHandler
// already accepts from the browser. Updates the line's status and appends
// the append-only audit row in the same call.
export async function recordLineDecision({ orderId, lineId, actor, action, payload = {}, statusPatch = {} }) {
  const supabase = db();
  let line = null;
  if (lineId && Object.keys(statusPatch).length) {
    line = unwrap(
      await supabase
        .from("order_lines")
        .update({ ...statusPatch, updated_at: new Date().toISOString() })
        .eq("id", lineId)
        .eq("order_id", orderId)
        .select()
        .single()
    );
  }
  await recordDecision({ orderId, orderLineId: lineId, actor, action, payload });
  return line;
}

export async function recordDecision({ orderId, orderLineId, actor, action, payload = {} }) {
  const supabase = db();
  return unwrap(
    await supabase
      .from("decisions")
      .insert({ order_id: orderId, order_line_id: orderLineId ?? null, actor, action, payload })
      .select()
      .single()
  );
}

export async function setOrderStatus({ orderId, status }) {
  const supabase = db();
  return unwrap(
    await supabase
      .from("orders")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .select()
      .single()
  );
}

// Aggregates a set of just-decided lines into the order-level status: all
// approved in full -> confirmed, a mix of approved/partial/split/skipped ->
// partially_confirmed, nothing approved at all is still partially_confirmed
// (an order with every line skipped is a real, if unusual, outcome — not
// silently "confirmed"). Pure function so it's independently testable.
export function deriveOrderStatus(lineStatuses) {
  if (!lineStatuses.length) return "in_review";
  const approvedCount = lineStatuses.filter((s) => s === "approved").length;
  if (approvedCount === lineStatuses.length) return "confirmed";
  return "partially_confirmed";
}
