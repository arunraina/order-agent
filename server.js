import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { processOrder } from "./src/run.js";
import { catalogue } from "./src/catalogue.js";
import { checkStock, listStock, setStock } from "./src/stock.js";
import { approvedLine, skippedLine, backorderedLine, manualNoteLine } from "./src/decide.js";
import { priceOrder } from "./src/pricing.js";
import {
  createOrder,
  getOrder,
  chooseCandidate,
  recordLineDecision,
  setOrderStatus,
} from "./src/db.js";
import { toBuyerLine, toBuyerOrder } from "./src/buyer-view.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// Runs the read-only part of the pipeline (extract -> match) and returns
// every candidate's stock position alongside it — nothing here writes
// anything, browser or external caller alike.
async function processHandler(req, res) {
  const orderText = (req.body?.orderText ?? "").trim();
  if (!orderText) return res.status(400).json({ error: "orderText is required" });

  try {
    const { notes, counts, results } = await processOrder(orderText);
    const withStock = results.map((r) => ({
      ...r,
      candidates: r.candidates.map((c) => ({ ...c, stock: checkStock(c.sku_code, r.quantity) })),
    }));
    res.json({ notes, counts, results: withStock });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "extraction failed" });
  }
}

// The only handler in this whole app that writes a file, and even this
// only ever writes a draft — the same "propose, a human decides, never an
// automatic write" boundary as the CLI. `decisions[i]` is one of:
//   { action: "skip" }
//   { action: "approve_full", candidateIndex }
//   { action: "partial", candidateIndex }
//   { action: "split", candidateIndex, eta }
//   { action: "manual_note", note }
function confirmHandler(req, res) {
  const { orderText, results, decisions } = req.body ?? {};
  if (!Array.isArray(results) || !Array.isArray(decisions)) {
    return res.status(400).json({ error: "results and decisions arrays are required" });
  }

  const lines = [];
  results.forEach((r, i) => {
    const d = decisions[i] ?? { action: "skip" };

    if (d.action === "manual_note") {
      lines.push(manualNoteLine(r, (d.note || "").trim()));
      return;
    }
    if (d.action !== "approve_full" && d.action !== "partial" && d.action !== "split") {
      lines.push(skippedLine(r, "skipped by reviewer"));
      return;
    }

    const candidate = r.candidates?.[d.candidateIndex ?? 0];
    if (!candidate) {
      lines.push(skippedLine(r, "no candidate selected"));
      return;
    }

    const reason = r.verdict === "ambiguous" ? "human-resolved ambiguity" : "auto-matched, human-approved";

    if (d.action === "approve_full") {
      lines.push(approvedLine(r, candidate, reason));
    } else if (d.action === "partial") {
      const stock = checkStock(candidate.sku_code, r.quantity);
      lines.push(approvedLine({ ...r, quantity: stock.available }, candidate, "partial fulfilment — remainder dropped", r.quantity));
    } else if (d.action === "split") {
      const stock = checkStock(candidate.sku_code, r.quantity);
      lines.push(approvedLine({ ...r, quantity: stock.available }, candidate, "split fulfilment — immediate portion", r.quantity));
      lines.push(backorderedLine(r, candidate, stock.short_by, r.quantity, d.eta));
    }
  });

  const { lines: pricedLines, totals } = priceOrder(lines);

  const draft = {
    created_at: new Date().toISOString(),
    source_text: orderText ?? "",
    lines: pricedLines,
    totals,
    status: "draft_reviewed",
  };

  const dir = join(__dirname, "data", "confirmed-orders");
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(draft, null, 2));

  res.json({ draft, file: outPath });
}

// Buyer-facing order flow (public/index.html + public/order.html). Unlike
// processHandler above, this path persists — a buyer's order and every
// decision made on it needs to survive past the browser tab, since the
// operator reviews it later and the buyer comes back to check on it.
// toBuyerLine/toBuyerOrder (src/buyer-view.js) are what keep this route
// buyer-safe: no score, no sku_code, no raw candidate list.

// Once nothing is left "pending" (every line auto-matched, or the buyer
// has picked a candidate or left a note for every ambiguous/no_match one),
// the order moves from "submitted" to "in_review" — there's nothing more
// for the buyer to do, it's the operator's turn.
async function advanceIfFullyActioned(orderId) {
  const { order, lines } = await getOrder(orderId);
  if (order.status === "submitted" && !lines.some((l) => l.status === "pending")) {
    await setOrderStatus({ orderId, status: "in_review" });
  }
}

async function createOrderRecordHandler(req, res) {
  const { buyerName, buyerPhone, orderText } = req.body ?? {};
  const text = (orderText ?? "").trim();
  if (!text) return res.status(400).json({ error: "orderText is required" });

  try {
    const { notes, counts, results } = await processOrder(text);
    if (!results.length) {
      return res.json({ orderId: null, notes, counts });
    }
    const withStock = results.map((r) => ({
      ...r,
      candidates: r.candidates.map((c) => ({ ...c, stock: checkStock(c.sku_code, r.quantity) })),
    }));
    const { order } = await createOrder({ orderText: text, buyerName, buyerPhone, results: withStock });
    await advanceIfFullyActioned(order.id);
    res.json({ orderId: order.id, notes, counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "failed to create order" });
  }
}

async function getOrderRecordHandler(req, res) {
  try {
    const { order, lines } = await getOrder(req.params.id);
    res.json({ order: toBuyerOrder(order), lines: lines.map(toBuyerLine) });
  } catch (err) {
    res.status(404).json({ error: "order not found" });
  }
}

async function chooseLineHandler(req, res) {
  const { id: orderId, lineId } = req.params;
  const { optionIndex } = req.body ?? {};
  try {
    const { lines } = await getOrder(orderId);
    const line = lines.find((l) => l.id === lineId);
    if (!line) return res.status(404).json({ error: "line not found" });
    const candidate = line.candidates?.[optionIndex];
    if (!candidate) return res.status(400).json({ error: "invalid option" });

    await chooseCandidate({ orderId, lineId, skuCode: candidate.sku_code, actor: "buyer" });
    await advanceIfFullyActioned(orderId);
    const { lines: refreshed } = await getOrder(orderId);
    res.json({ line: toBuyerLine(refreshed.find((l) => l.id === lineId)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to record choice" });
  }
}

async function noteLineHandler(req, res) {
  const { id: orderId, lineId } = req.params;
  const note = (req.body?.note ?? "").trim();
  if (!note) return res.status(400).json({ error: "note is required" });
  try {
    await recordLineDecision({
      orderId, lineId, actor: "buyer", action: "manual_note",
      payload: { note }, statusPatch: { status: "manual_note", note },
    });
    await advanceIfFullyActioned(orderId);
    const { lines } = await getOrder(orderId);
    res.json({ line: toBuyerLine(lines.find((l) => l.id === lineId)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to save note" });
  }
}

// Stock management: the "Manual" tier from the Griffy Supply design — a
// distributor sets their own number, no external system involved. This is
// the only genuinely live data in the whole catalogue; everything else
// (price, hsn, gst_rate) is still static sample data.
function stockListHandler(req, res) {
  res.json({ skus: listStock() });
}
function stockSetHandler(req, res) {
  const { sku_code, qty } = req.body ?? {};
  if (!sku_code || typeof qty !== "number" || qty < 0) {
    return res.status(400).json({ error: "sku_code (string) and qty (number >= 0) are required" });
  }
  try {
    const updated = setStock(sku_code, qty, req.get("x-api-key") ? "external_api" : "web_ui");
    res.json({ sku_code, ...updated });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}

// The browser UI (public/index.html) hits these directly, same-origin, no
// key — this is the local demo path.
app.post("/api/process", processHandler);
app.post("/api/confirm", confirmHandler);
app.get("/api/stock", stockListHandler);
app.post("/api/stock", stockSetHandler);

// Buyer flow: submit an order, then track it. public/order.html reads the
// order id out of the URL itself, so /orders/:id always serves the same
// static page — the persisted state, not the URL, decides what it shows.
app.post("/api/orders", createOrderRecordHandler);
app.get("/api/orders/:id", getOrderRecordHandler);
app.post("/api/orders/:id/lines/:lineId/choose", chooseLineHandler);
app.post("/api/orders/:id/lines/:lineId/note", noteLineHandler);
app.get("/orders/:id", (req, res) => res.sendFile(join(__dirname, "public", "order.html")));

// External systems (another company's dispatch tool, a future SAP/Tally
// adapter) hit the versioned, key-gated path instead. Same handlers, same
// governance — an external caller gets exactly the same "propose, never
// write without an explicit decision" contract as a human at the browser,
// not a shortcut around it.
const API_KEY = process.env.ORDER_AGENT_API_KEY || "dev-local-key-change-me";
if (!process.env.ORDER_AGENT_API_KEY) {
  console.log(`No ORDER_AGENT_API_KEY set in .env — external API is using the default dev key: ${API_KEY}`);
}

function requireApiKey(req, res, next) {
  if (req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "missing or invalid x-api-key header" });
  }
  next();
}

app.get("/api/v1/health", requireApiKey, (req, res) => res.json({ ok: true }));

app.get("/api/v1/catalogue", requireApiKey, (req, res) => {
  res.json({ count: catalogue.length, skus: catalogue });
});

app.post("/api/v1/process", requireApiKey, processHandler);
app.post("/api/v1/confirm", requireApiKey, confirmHandler);
app.get("/api/v1/stock", requireApiKey, stockListHandler);
app.post("/api/v1/stock", requireApiKey, stockSetHandler);

const PORT = process.env.PORT || 3500;
app.listen(PORT, () => {
  console.log(`order-agent web UI running at http://localhost:${PORT}`);
});
