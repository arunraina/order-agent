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

---

## How this was built, and why — for interview prep

This section exists so the reasoning survives, not just the code. Everything
below is true of this exact repo — every file/function named here exists,
right now, doing what's described.

### The problem, in one sentence

A distributor gets orders as free text from people who don't type SKU codes
— they type "12mm saria 2 ton tata" — and turning that into a real order
today means a human manually re-typing it into whatever system holds the
catalogue. The goal isn't "automate the order" — it's **remove the re-typing
without removing the human decision**, because the human decision (which
product, how much stock, is that quantity even right) is the part that
actually needs judgment.

### Use cases this demonstrates

1. **Free-text intake** — a buyer types however they'd naturally text a
   distributor (Hinglish, abbreviations, brand-first or spec-first word
   order), and it still resolves to real catalogue SKUs.
2. **Governed ambiguity resolution** — when the text genuinely doesn't say
   enough (no brand, two products score identically), the system asks
   instead of guessing, and asks the *right* party: the buyer if it's their
   intent that's unclear, the operator if it's a business call (stock
   shortfall, which of two visually-identical SKUs to substitute).
3. **Human-gated fulfilment** — nothing ships, and no inventory moves, until
   a specific person with a specific role takes a specific action on a
   specific line. Every one of those four words is enforced in code, not
   just policy (see Guardrails below).
4. **External system integration** — the same governed pipeline is
   reachable by another system (a distributor's own dispatch tool) via a
   key-gated API, so this can sit behind something else rather than only
   being a standalone app.

### Build order, and why each step had to come before the next

This is the order the commits actually happened in, because the sequencing
matters — each layer only makes sense once the one below it exists:

1. **Catalogue first** (`data/sku-master.json`, `src/catalogue.js`). Nothing
   else can be tested without something to match against. 20 real-shaped
   SKUs (cement, TMT steel, tiles, sanitaryware, electrical, aggregate),
   each with brand/spec/uom/hsn/gst_rate — illustrative sample data, but
   shaped exactly like a real catalogue so the rest of the pipeline isn't
   solving an easier problem than the real one.
2. **Deterministic matching before AI extraction** (`src/match.js`). Scoring
   text against a catalogue is a solved, testable, deterministic problem —
   build and debug that first, against hand-written fixture lines, before
   introducing an LLM's non-determinism into the mix. Getting the matcher
   right first also means the extraction step downstream has a stable
   target to prove itself against.
3. **Extraction** (`src/extract.js`) — Claude turns raw text into typed
   line items (quantity, unit, category, brand, spec). This is the one LLM
   call in the whole pipeline, deliberately scoped as narrowly as possible:
   structured extraction, not decision-making.
4. **Unit reconciliation** (`src/units.js`) — a customer's word ("bora",
   "ton", "nos") isn't the catalogue's unit of measure; flagged when they
   don't reconcile, never silently converted.
5. **Stock and pricing** (`src/stock.js`, `src/pricing.js`) — once matching
   works, "is it in stock" and "what does it cost" are the next real
   questions a human needs answered to make a decision.
6. **The decision layer** (`src/decide.js`) — pure functions describing what
   an approved/skipped/backordered/manually-noted line *is*, with zero I/O.
   Built before any UI, so the CLI, the external API, and the operator's
   confirm handler could all share one answer to "what does an approval
   look like" instead of three copies drifting apart (see Guardrails).
7. **CLI first, web UI second** (`src/approve.js`, then `server.js` +
   `public/`) — proved the human-in-the-loop flow in a terminal (readline
   prompts) before building a browser UI around the same primitives.
8. **Persistence** (`src/db.js`, Supabase) — added only once the pipeline
   itself worked end to end in memory. An order and its decisions need to
   outlive one browser tab; a `POST` that computes something and returns it
   doesn't need a database.
9. **Splitting one shared UI into a buyer view and an operator view**
   (`src/buyer-view.js`, `views/`) — the original single-page tool let
   whoever opened it both extract *and* approve, which conflates "the
   person who wants something" with "the person authorized to commit
   inventory to them." Splitting these was the point at which
   passcode-gating (see Guardrails) actually became necessary, not
   optional.
10. **Closing real gaps found by using it** — two came from actually
    exercising the deployed app, not from planning: stock shown to a buyer
    or operator was a point-in-time snapshot that went stale as other
    orders moved the same inventory (fixed by recomputing at read time),
    and approving an order never actually decremented stock at all, so two
    concurrent approvals against the same low-stock SKU could both succeed
    (fixed with an atomic, race-safe decrement — see Guardrails). Both are
    the kind of bug that only shows up once multiple people can touch the
    same data, which is exactly what step 9 made possible.

### Scoring — how matching actually decides

The core problem: turn "12mm saria 2 ton tata" into a ranked list of real
SKUs, without an LLM call for every comparison (20 SKUs today, but this has
to work at 2,000).

- **Tokenize, then weight.** `normalize()` lowercases and splits numbers
  from letters ("12mm" → "12 mm") so a dimension is never glued to a unit.
  A numeric token counts for **3x** a word token when scoring — in
  construction, the number *is* the product (12mm rebar vs 16mm rebar are
  different SKUs; "TMT bar" alone is not).
- **Protect compound tokens before the generic split destroys them.**
  "600x600" and "1.5" would otherwise degrade to bare digits ("600", "5")
  once "x" and "." are stripped as punctuation — and two different tile
  sizes, or two different wire gauges, would then score identically.
  `compoundTokens()` extracts dimension-pairs and decimals as atomic tokens
  *before* the generic splitter can break them apart.
- **Strip the quantity before scoring.** "reta 300 cft" — 300 is how much
  the buyer wants, not a fact about the product. Left in, it competes with
  a genuine spec digit under the 3x numeric weight, and a coincidental
  quantity/dimension collision (300 cft landing on a 300x600mm tile) can
  outrank the actual match. `stripQuantity()` removes it first.
- **Filter on what's known, rank only on what's unknown.** If the extractor
  was confident about a spec ("12mm"), any candidate whose own spec
  contradicts that ("8mm") is filtered out entirely before scoring even
  starts — `specContradicts()` — so a fact the extractor was sure of can
  never be silently outranked by word-overlap instead of excluded outright.
- **Three verdicts, decided by a floor and a margin, not a single
  threshold:**
  ```
  MIN_SCORE = 0.20          // below this: nothing cleared the confidence floor
  AMBIGUITY_MARGIN = 0.15   // top two scores this close: can't tell them apart
  ```
  - `no_match` — nothing cleared `MIN_SCORE`, or everything left contradicted
    a known spec.
  - `matched` — exactly one candidate survived, or the top score clearly
    separates from the runner-up, **and** nothing the extractor flagged as
    missing (brand/spec) would actually change which SKU ships if it were
    known (`missingIsMoot()` — see below).
  - `ambiguous` — otherwise. Sent to a human, never guessed.
- **A missing fact only matters if it's a fact that would change the
  outcome.** Early on, the matcher forced `ambiguous` any time the
  extractor flagged something absent (no brand mentioned), even when only
  one real candidate existed or every surviving candidate agreed on that
  exact attribute anyway. `missingIsMoot(candidates, missing)` checks
  whether the missing attribute actually varies across the survivors —
  if it doesn't, there's nothing left to ask about, so the verdict is
  `matched` instead of manufacturing a decision nobody needed to make.

### Guardrails — what actually stops this from doing something wrong

Each of these is a specific mechanism, not a policy statement:

- **Exactly one code path writes anything, ever.** The CLI's approval flow,
  the external API's confirm handler, and the operator's confirm handler
  all build their output through the *same* `src/decide.js` primitives
  (`approvedLine`, `skippedLine`, `backorderedLine`, `manualNoteLine`) —
  "what does an approved line look like" has one implementation, so it
  can't drift into three different answers across three surfaces.
- **The buyer cannot see or influence which SKU gets picked beyond
  choosing among options the matcher already returned.** Resolving an
  ambiguous line sends an array *index*, never a `sku_code` — the server
  looks up the real SKU from that position in the stored candidate list.
  There is no field a buyer's browser can send that maps directly to a
  SKU. Enforced in `src/buyer-view.js` and the `/api/orders/:id/lines/*`
  handlers.
- **The buyer never sees a score, a `sku_code`, or the raw candidate
  list** — only a product name and a stock band (`in_stock` / `limited` /
  `out_of_stock`, never the exact number). One pure transform
  (`toBuyerLine`/`toBuyerOrder`) is the only place that shape is built, so
  every route talking to a buyer's browser goes through it rather than
  each hand-rolling its own "safe" version.
- **The operator view is gated, and gated in a way that can't be bypassed
  by knowing a URL.** `/admin/*` pages live in `views/`, not `public/` —
  Express's static file server can only ever serve `public/`, so there's
  no direct path to an operator page that skips the passcode check, even
  if someone guesses the exact filename. Verified directly (see commit
  history): `/admin-orders.html` and `/views/admin-orders.html` both 404
  from outside the auth-gated route.
- **Money and stock rules live in exactly one place.** `src/pricing.js` is
  the only file that prices a line; `src/stock.js` is the only file that
  reads or writes a stock number. Nothing downstream recomputes either
  independently — a lesson taken directly from a real incident in the
  companion Griffy codebase, where three separate copies of a fee
  calculation drifted apart and customers were shown one number and
  billed another.
- **Approving stock is atomic, not read-then-write.** `decrementStockExact`/
  `decrementStockUpTo` (`src/stock.js`) do a synchronous read-check-write
  in one call with no `await` inside it — closing a real race where two
  concurrent approvals against the same low-stock SKU could otherwise both
  read the same pre-decrement number and both succeed, overselling it.
  Guaranteed within a single process; scaling this app to multiple
  instances would need a real database row lock instead (noted inline in
  `stock.js`).
- **Every write to Supabase requires the service_role key; RLS is on with
  no anon/authenticated policies.** A client using the public key gets
  nothing from these tables — the server is the only trusted writer, same
  reasoning as the passcode gate on the browser side.
- **An append-only audit log, not a mutable status field.** `decisions`
  gets one row per action, ever — who (`buyer`/`operator`/`system`), what
  action, what it was based on. Nothing updates or deletes a row here, so
  "what actually happened to this order" is always reconstructable, not
  just "what its current status says."

### Integrations — what's real, what's a documented placeholder

| Integration | Status |
|---|---|
| Anthropic Claude (extraction) | **Live** — forced tool-use, one call per order |
| Supabase / Postgres (persistence) | **Live** — dedicated `order_agent` schema |
| Railway (hosting) | **Live** — auto-deploys on push to `main` |
| External API (`x-api-key`-gated `/api/v1/*`) | **Live** — same handlers as the original ephemeral flow, for another system to call |
| Tally XML export/import | **Documented, not built** — no real tenant to test against |
| SAP Business One Service Layer | **Documented, not built** — same reason |
| Manual stock entry | **Live** — the one genuinely live catalogue data, editable from the operator's "Manage stock" panel |

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
