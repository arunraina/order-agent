# order-agent — PO Intake Agent

A working demo of the "PO Intake Agent" concept: a distributor gets a
contractor's order as unstructured text (WhatsApp, email — see
`Bhai site pe bhejna hai - ambuja opc 43 ke 150 bora, 12mm saria 2 ton tata`),
and this turns it into a reviewable, typed proposal — never an automatic
write.

**Nothing in this codebase calls an order-creation endpoint.** The only
output is a draft JSON file a human has explicitly approved, line by line,
via either the CLI or the local web UI below.

## Setup

```
npm install
cp .env.example .env    # then put a real ANTHROPIC_API_KEY in .env
```

## Running it

**Web UI** (recommended — lets you click through the approval flow):

```
node server.js
```

Then open **http://localhost:3500** in your own browser. Paste an order,
or use one of the three sample-order buttons, hit **Process order**, then
resolve each line (approve / skip / pick a candidate / partial / split with
an ETA) and hit **Confirm order**.

**CLI** (same pipeline, terminal-driven):

```
node src/run.js 0        # extract + match only, prints verdicts, no approval
node src/approve.js 0    # full pipeline with interactive approval prompts
```

`0`, `1`, `2` select one of the three sample orders in `data/sample-orders.json`.

## How it works — the layers

```
data/sku-master.json  →  the catalogue (SKU, brand, spec, uom, hsn, gst_rate, stock_qty, aliases)

src/catalogue.js   Layer 1 — loads the catalogue, exposes searchableText()
src/extract.js     Layer 3 — Claude call, forced tool-use JSON, turns raw text
                    into typed line items (quantity, unit, category, brand, spec)
src/match.js       Layer 2 — token-weighted matcher, scores each line's text
                    against every SKU, returns matched / ambiguous / no_match
src/units.js       reconciles the customer's word ("bora", "ton", "nos") against
                    the catalogue's own unit of measure
src/stock.js       checks requested quantity against stock_qty — in_stock /
                    insufficient / out_of_stock
src/decide.js       pure decision primitives (approvedLine, skippedLine,
                    backorderedLine) — shared by both the CLI and the web UI,
                    so "what does an approved line look like" has one answer
src/run.js         orchestrates extract → match → verdict counts
src/approve.js      CLI: walks a human through every line, writes the draft
server.js + public/  web UI: same decisions, browser-driven instead of stdin
```

## Why every line still needs a human

Four exceptions are handled distinctly, never silently:

- **Ambiguous match** — top candidates are too close to call, or the
  extractor flagged a missing brand/spec. You pick.
- **No match** — nothing cleared the confidence floor. You add a manual
  note or skip.
- **Unit mismatch** — the customer's unit doesn't map to this SKU's uom.
  Flagged, not forced.
- **Insufficient stock** — three real choices, not a guess: partial now
  (drop the rest), split (some now, the rest backordered with an ETA), or
  approve the full amount anyway (accepting the shortage risk).

## Known limitations

- `stock_qty` and any pricing data in the catalogue are **illustrative
  sample data**, not a live feed from a real ERP.
- Not connected to any real SAP/Tally/Busy instance. The matching design
  (canonical entities, one adapter per ERP) is documented as a pattern in
  the companion case study, not implemented here.
- No automated test suite yet.
