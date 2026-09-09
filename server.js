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
  listOrdersWithLineCounts,
  chooseCandidate,
  recordLineDecision,
  setOrderStatus,
  deriveOrderStatus,
} from "./src/db.js";
import { toBuyerLine, toBuyerOrder } from "./src/buyer-view.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // the /admin/login form posts this way
app.use(express.static(join(__dirname, "public")));

// The original ephemeral flow: paste text in, get a priced draft back,
// nothing persisted anywhere but a local JSON file. Once the buyer and
// operator views below shipped, nothing in the browser calls these two
// handlers any more — they're kept as the implementation behind
// /api/v1/process + /api/v1/confirm, the external-system integration path
// documented in the README, which has no reason to move to Supabase.
//
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
// (price, hsn, gst_rate) is still static sample data. Reused by both the
// key-gated external API and the passcode-gated /api/admin/stock — same
// handlers, same "who's allowed to write" question, two different callers.
function stockListHandler(req, res) {
  res.json({ skus: listStock() });
}
function stockSetHandler(req, res) {
  const { sku_code, qty } = req.body ?? {};
  if (!sku_code || typeof qty !== "number" || qty < 0) {
    return res.status(400).json({ error: "sku_code (string) and qty (number >= 0) are required" });
  }
  try {
    const updated = setStock(sku_code, qty, req.get("x-api-key") ? "external_api" : "operator_ui");
    res.json({ sku_code, ...updated });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}

// Buyer flow: submit an order, then track it. public/order.html reads the
// order id out of the URL itself, so /orders/:id always serves the same
// static page — the persisted state, not the URL, decides what it shows.
app.post("/api/orders", createOrderRecordHandler);
app.get("/api/orders/:id", getOrderRecordHandler);
app.post("/api/orders/:id/lines/:lineId/choose", chooseLineHandler);
app.post("/api/orders/:id/lines/:lineId/note", noteLineHandler);
app.get("/orders/:id", (req, res) => res.sendFile(join(__dirname, "public", "order.html")));

// Operator view. Gated by one shared passcode from an env var — not a real
// auth system, deliberately: there's one operator role, not per-user
// accounts, so a session token would be modeling users this app doesn't
// have. The cookie holds the passcode itself (httpOnly, so page JS can't
// read it); every request just compares it to the configured value. The
// pages this gate protects live in views/, not public/, specifically so
// express.static can't serve them straight past the check — a file under
// public/ is reachable by anyone who knows its path regardless of any
// route guard added elsewhere.
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "admin-local-dev";
if (!process.env.ADMIN_PASSCODE) {
  console.log(`No ADMIN_PASSCODE set in .env — operator login is using the default dev passcode: ${ADMIN_PASSCODE}`);
}
const ADMIN_COOKIE = "order_agent_admin";
const VIEWS_DIR = join(__dirname, "views");

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i === -1) return;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}
function isAdminAuthed(req) {
  return parseCookies(req.headers.cookie)[ADMIN_COOKIE] === ADMIN_PASSCODE;
}
function requireAdminPage(req, res, next) {
  if (isAdminAuthed(req)) return next();
  res.sendFile(join(VIEWS_DIR, "admin-login.html"));
}
function requireAdminApi(req, res, next) {
  if (isAdminAuthed(req)) return next();
  res.status(401).json({ error: "not authenticated" });
}

app.post("/admin/login", (req, res) => {
  const passcode = (req.body?.passcode ?? "").trim();
  if (passcode !== ADMIN_PASSCODE) return res.redirect("/admin?error=1");
  res.cookie(ADMIN_COOKIE, ADMIN_PASSCODE, { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 12 });
  res.redirect("/admin");
});
app.post("/admin/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.redirect("/admin");
});
app.get("/admin", requireAdminPage, (req, res) => res.sendFile(join(VIEWS_DIR, "admin-orders.html")));
app.get("/admin/orders/:id", requireAdminPage, (req, res) => res.sendFile(join(VIEWS_DIR, "admin-order.html")));

async function listAdminOrdersHandler(req, res) {
  try {
    res.json({ orders: await listOrdersWithLineCounts() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list orders" });
  }
}

// Unlike the buyer's GET /api/orders/:id, this is the raw, full shape —
// scores, sku_code, exact stock numbers, everything findCandidates()
// returned. The operator is exactly who this data is for.
async function getAdminOrderHandler(req, res) {
  try {
    const { order, lines } = await getOrder(req.params.id);
    res.json({ order, lines });
  } catch (err) {
    res.status(404).json({ error: "order not found" });
  }
}

// The operator's confirm — same decision shapes the old ephemeral
// confirmHandler took (approve_full / partial / split / skip / manual_note
// per line), except each one now writes an audit row via recordLineDecision
// instead of only ending up in a JSON draft, and a line missing a chosen
// candidate can still get one here: an ambiguous line the buyer left
// unresolved is exactly as answerable by the operator as by the buyer,
// same chooseCandidate() call, actor "operator" instead of "buyer".
async function confirmAdminOrderHandler(req, res) {
  const orderId = req.params.id;
  const { decisions } = req.body ?? {};
  if (!Array.isArray(decisions)) {
    return res.status(400).json({ error: "decisions array is required" });
  }

  try {
    const { lines } = await getOrder(orderId);
    const priceableLines = [];

    for (const d of decisions) {
      const line = lines.find((l) => l.id === d.lineId);
      if (!line) continue;
      const r = { raw_text: line.raw_text, quantity: line.quantity, unit: line.unit };

      if (d.action === "manual_note") {
        const note = (d.note || "").trim();
        await recordLineDecision({
          orderId, lineId: line.id, actor: "operator", action: "manual_note",
          payload: { note }, statusPatch: { status: "manual_note", note },
        });
        priceableLines.push(manualNoteLine(r, note));
        continue;
      }

      if (d.action !== "approve_full" && d.action !== "partial" && d.action !== "split") {
        await recordLineDecision({
          orderId, lineId: line.id, actor: "operator", action: "skip",
          payload: {}, statusPatch: { status: "skipped" },
        });
        priceableLines.push(skippedLine(r, "skipped by reviewer"));
        continue;
      }

      let candidate = line.chosen_sku_code
        ? line.candidates.find((c) => c.sku_code === line.chosen_sku_code)
        : null;
      if (!candidate && d.candidateIndex != null) {
        candidate = line.candidates?.[d.candidateIndex] ?? null;
        if (candidate) {
          await chooseCandidate({ orderId, lineId: line.id, skuCode: candidate.sku_code, actor: "operator" });
        }
      }
      if (!candidate) {
        await recordLineDecision({
          orderId, lineId: line.id, actor: "operator", action: "skip",
          payload: { reason: "no candidate selected" }, statusPatch: { status: "skipped" },
        });
        priceableLines.push(skippedLine(r, "no candidate selected"));
        continue;
      }

      const reason = line.verdict === "ambiguous" ? "human-resolved ambiguity" : "auto-matched, human-approved";

      if (d.action === "approve_full") {
        await recordLineDecision({
          orderId, lineId: line.id, actor: "operator", action: "approve_full",
          payload: { sku_code: candidate.sku_code }, statusPatch: { status: "approved" },
        });
        priceableLines.push(approvedLine(r, candidate, reason));
      } else if (d.action === "partial") {
        const stock = checkStock(candidate.sku_code, line.quantity);
        await recordLineDecision({
          orderId, lineId: line.id, actor: "operator", action: "partial",
          payload: { sku_code: candidate.sku_code, fulfilled_qty: stock.available },
          statusPatch: { status: "partial" },
        });
        priceableLines.push(approvedLine({ ...r, quantity: stock.available }, candidate, "partial fulfilment — remainder dropped", line.quantity));
      } else if (d.action === "split") {
        const stock = checkStock(candidate.sku_code, line.quantity);
        await recordLineDecision({
          orderId, lineId: line.id, actor: "operator", action: "split",
          payload: { sku_code: candidate.sku_code, fulfilled_qty: stock.available, backordered_qty: stock.short_by, eta: d.eta || null },
          statusPatch: { status: "split" },
        });
        priceableLines.push(approvedLine({ ...r, quantity: stock.available }, candidate, "split fulfilment — immediate portion", line.quantity));
        priceableLines.push(backorderedLine(r, candidate, stock.short_by, line.quantity, d.eta));
      }
    }

    const { lines: finalLines } = await getOrder(orderId);
    const updatedOrder = await setOrderStatus({ orderId, status: deriveOrderStatus(finalLines.map((l) => l.status)) });
    const { lines: pricedLines, totals } = priceOrder(priceableLines);

    res.json({ order: { id: updatedOrder.id, status: updatedOrder.status }, lines: pricedLines, totals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to confirm order" });
  }
}

app.get("/api/admin/orders", requireAdminApi, listAdminOrdersHandler);
app.get("/api/admin/orders/:id", requireAdminApi, getAdminOrderHandler);
app.post("/api/admin/orders/:id/confirm", requireAdminApi, confirmAdminOrderHandler);
app.get("/api/admin/stock", requireAdminApi, stockListHandler);
app.post("/api/admin/stock", requireAdminApi, stockSetHandler);

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
