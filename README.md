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

Persistence (orders/order_lines/decisions) needs a Supabase project too — see
[Persistence](#persistence) below.

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
data/sku-master.json  →  the catalogue (SKU, brand, spec, uom, hsn, gst_rate, unit_price, aliases)

src/catalogue.js   Layer 1 — loads the catalogue, exposes searchableText()
src/extract.js     Layer 3 — Claude call, forced tool-use JSON, turns raw text
                    into typed line items (quantity, unit, category, brand, spec)
src/match.js       Layer 2 — token-weighted matcher, scores each line's text
                    against every SKU, returns matched / ambiguous / no_match
src/units.js       reconciles the customer's word ("bora", "ton", "nos") against
                    the catalogue's own unit of measure
src/stock.js       the only genuinely live data source — checks requested
                    quantity against a manually-set stock number
                    (data/stock-overrides.json, gitignored), falling back to
                    the catalogue's baseline stock_qty when nothing's been set
src/pricing.js     prices approved/backordered lines from unit_price + gst_rate,
                    rolls up "payable now" vs. "pending on backorder"
src/roi.js         a sizing model (minutes saved × order volume) — assumptions
                    you'd validate with real timing data, not a measured result
src/decide.js       pure decision primitives (approvedLine, skippedLine,
                    backorderedLine) — shared by both the CLI and the web UI,
                    so "what does an approved line look like" has one answer
src/run.js         orchestrates extract → match → verdict counts
src/approve.js      CLI: walks a human through every line, writes the priced draft
src/db.js          Supabase persistence — orders/order_lines/decisions
                    (see Persistence below); not yet wired into any route
server.js + public/  web UI: same decisions, browser-driven instead of stdin —
                    plus a "Manage stock" panel and a key-gated /api/v1/*
                    surface for external callers
```

## Persistence

Orders, their lines, and every decision made on them are stored in Postgres
via Supabase, in a dedicated `order_agent` schema (not `public` — this can
share a Supabase project with other apps without any table-name collision).

```
order_agent.orders        one row per submitted order (buyer, raw text, status)
order_agent.order_lines   one row per extracted line (verdict, candidates,
                           chosen_sku_code, status) — candidates carries the
                           full scored list with sku_code, so this table (and
                           only this table) is operator-facing, not buyer-safe
order_agent.decisions     append-only audit log — one row per action, ever;
                           never updated or deleted
```

Set up:

```
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # Settings > API > service_role secret key
```

`src/db.js` uses the **service_role** key deliberately, not the anon key —
this server is the trusted party writing these tables, the same reason
`ORDER_AGENT_API_KEY` gates the external surface rather than relying on
Supabase Auth. RLS is enabled on all three tables with no policies for
`anon`/`authenticated`, so a client using the public anon key gets nothing;
service_role bypasses RLS by design.

`src/db.js` isn't called from any route yet — that lands with the buyer and
operator views in the next two pieces of work. For now it's a standalone,
independently-usable module: `createOrder`, `getOrder`, `listOrders`,
`chooseCandidate`, `recordLineDecision`, `setOrderStatus`, and the pure
`deriveOrderStatus(lineStatuses)` helper that decides `confirmed` vs.
`partially_confirmed` from a set of just-decided line statuses.

## External API

Same handlers as the browser UI, reachable by another system (a distributor's
own dispatch tool, a future ERP adapter), gated by an `x-api-key` header:

```
GET  /api/v1/health
GET  /api/v1/catalogue
GET  /api/v1/stock
POST /api/v1/stock      { sku_code, qty }
POST /api/v1/process    { orderText }
POST /api/v1/confirm    { orderText, results, decisions }
```

Set `ORDER_AGENT_API_KEY` in `.env` — without it, the server logs a dev
fallback key at startup (fine for local testing, not for a public deployment).

## Live stock

`/api/v1/stock` and the in-app "Manage stock" panel are the one genuinely
live thing here — everything else (price, HSN, GST rate) stays static sample
data. This is the "Manual" tier from the companion Griffy Supply case study:
a distributor sets their own number, no external system involved. Writes go
to `data/stock-overrides.json` (gitignored — it's runtime state, not a
fixture) and take effect immediately, overriding the catalogue's baseline.

Tally and SAP Business One integration are documented as the "Lite" and
"Connected" tiers in that same case study but aren't implemented here — no
real tenant to build and test against yet.

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
