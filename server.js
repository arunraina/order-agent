import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { processOrder } from "./src/run.js";
import { catalogue } from "./src/catalogue.js";
import { checkStock } from "./src/stock.js";
import { approvedLine, skippedLine, backorderedLine, manualNoteLine } from "./src/decide.js";
import { priceOrder } from "./src/pricing.js";

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

// The browser UI (public/index.html) hits these directly, same-origin, no
// key — this is the local demo path.
app.post("/api/process", processHandler);
app.post("/api/confirm", confirmHandler);

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

const PORT = process.env.PORT || 3500;
app.listen(PORT, () => {
  console.log(`order-agent web UI running at http://localhost:${PORT}`);
});
