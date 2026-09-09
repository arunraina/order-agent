# order-agent — PO Intake Agent

A working demo of the "PO Intake Agent" concept: a distributor gets a
contractor's order as unstructured text (WhatsApp, email — see
`Bhai site pe bhejna hai - ambuja opc 43 ke 150 bora, 12mm saria 2 ton tata`),
and this turns it into a reviewable, typed proposal — never an automatic
write.

**Nothing in this codebase calls an order-creation endpoint.** A buyer's
order only ever becomes a proposal — every line still needs an explicit
human decision, from the buyer (resolving which product they meant) or the
operator (approving what actually ships), before anything is final.

## Setup

```
npm install
cp .env.example .env    # then fill in the values below
```

Needs three things in `.env` to run for real: `ANTHROPIC_API_KEY` (extraction),
Supabase credentials (persistence — see [Persistence](#persistence)), and
`ADMIN_PASSCODE` (operator login — see [Operator view](#operator-view)).

## Running it

**Web UI** — two separate roles, two separate views:

```
node server.js
```

- **Buyer** — open **http://localhost:3500**. Give a name/phone (optional)
  and paste an order, or use a sample-order button, and submit. You land on
  `/orders/:id`, a status page that shows each line's outcome — resolved
  (product + stock band), needing a quick pick between a couple of options,
  or "couldn't match this, tell us more" — and updates on its own once an
  operator has acted.
- **Operator** — open **http://localhost:3500/admin** and sign in with
  `ADMIN_PASSCODE`. Lists every order; opening one shows the full review
  queue (scores, exact stock, candidate picks, partial/split/skip) and a
  Confirm button that sets the order's final status.

**CLI** (same extract+match pipeline, terminal-driven, no persistence —
useful for iterating on `src/match.js` without touching a database):

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
                    backorderedLine) — shared by the CLI, the external API,
                    and the operator confirm handler, so "what does an
                    approved line look like" has one answer everywhere
src/run.js         orchestrates extract → match → verdict counts
src/approve.js      CLI: walks a human through every line, writes a local
                    priced draft — no Supabase, a standalone tool
src/db.js          Supabase persistence — orders/order_lines/decisions
                    (see Persistence below)
src/buyer-view.js  pure transform from a persisted line/order to what a
                    buyer is allowed to see — no score, no sku_code, no
                    raw candidate list (see Buyer view below)
server.js          two gated web surfaces (buyer, operator — see below)
                    plus the key-gated /api/v1/* external API
public/            buyer-facing pages, served by express.static directly
views/             operator-facing pages — deliberately NOT under public/,
                    so express.static can't serve them straight past the
                    /admin passcode check; server.js sendFile()s them only
                    after requireAdminPage/requireAdminApi passes
```

## Buyer view

`public/index.html` (submit) and `public/order.html` (`/orders/:id`, track).
A buyer never sees a match score, a `sku_code`, or the full candidate list —
`src/buyer-view.js`'s `toBuyerLine`/`toBuyerOrder` are the one place that
shape gets built, reused by every route that talks to a buyer's browser.
Resolving an ambiguous line sends the array position of the option they
clicked, never a `sku_code` — nothing buyer-supplied can select a SKU
outside what `findCandidates()` actually returned for that line.

## Operator view

`/admin` (order list) and `/admin/orders/:id` (the full review queue —
scores, exact stock, candidate picks, partial/split/skip, Confirm). Gated by
one shared passcode from `ADMIN_PASSCODE` — deliberately not a real login
system: there's one operator role here, not per-user accounts. If unset, the
server logs a dev fallback passcode at startup.

Confirming writes one `decisions` row per line action (`approve_full`,
`partial`, `split`, `skip`, `manual_note`), and once every line has a final
status the order itself moves to `confirmed` (every line approved in full)
or `partially_confirmed` (anything else — a mix, or a fully skipped order,
is still a real recorded outcome, not silently "confirmed").

Stock management lives here too: manual entry (writes to
`data/stock-overrides.json`, same as `/api/v1/stock`), plus an explicit,
honest "Coming soon" placeholder for Tally / SAP Business One adapters —
not built, no real tenant to test against yet, but named rather than
implied.

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

`createOrder`, `getOrder`, `listOrders`, `listOrdersWithLineCounts`,
`chooseCandidate`, `recordLineDecision`, `setOrderStatus`, and the pure
`deriveOrderStatus(lineStatuses)` helper that decides `confirmed` vs.
`partially_confirmed` from a set of just-decided line statuses.

## External API

A separate, older path: `processHandler`/`confirmHandler` run the same
extract→match pipeline but never touch Supabase — the response is a priced
draft, same shape as before persistence existed. Nothing in the browser
calls these any more (the buyer and operator views above own that job now);
they're kept specifically as the external-system integration surface —
a distributor's own dispatch tool, a future ERP adapter — gated by an
`x-api-key` header instead of a browser session:

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

Stock is the one genuinely live thing in this catalogue — everything else
(price, HSN, GST rate) stays static sample data. This is the "Manual" tier
from the companion Griffy Supply case study: a distributor sets their own
number, no external system involved. Writes go to
`data/stock-overrides.json` (gitignored — it's runtime state, not a
fixture) and take effect immediately, overriding the catalogue's baseline.
Reachable from the operator's "Manage stock" panel (`/api/admin/stock`,
passcode-gated) or externally (`/api/v1/stock`, key-gated) — same two
handlers either way.

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
