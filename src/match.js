import { readFileSync } from "fs";
import { catalogue, searchableText } from "./catalogue.js";

const MIN_SCORE = 0.20;        // below this, we found nothing useful
const AMBIGUITY_MARGIN = 0.15; // top and runner-up this close = can't decide

// "12mm" -> "12 mm", "600x600" -> "600 x 600". Numbers must become
// their own tokens, because in construction the number IS the product.
export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The generic split above is exactly what breaks dimension pairs and
// decimals: "2x2" and "1x2" both degrade to a bare "2" once the "x" is
// stripped as a too-short token, and "1.5"/"2.5" both degrade to a bare
// "5" once the "." is stripped as punctuation. Two SKUs that should be
// clearly distinct (different tile size, different wire gauge) end up
// scoring identically. Pull these out as atomic tokens BEFORE the split
// destroys the pairing, and add them alongside the generic tokens rather
// than instead of them.
function compoundTokens(text) {
  const s = String(text ?? "").toLowerCase();
  const out = [];
  for (const m of s.matchAll(/\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?/g)) {
    out.push(m[0].replace(/\s+/g, ""));   // "600 x 600" / "600x600" -> "600x600"
  }
  for (const m of s.matchAll(/\d+\.\d+/g)) {
    out.push(m[0]);                        // "2.5" stays "2.5", distinct from "1.5"
  }
  return out;
}

export const tokenize = (text) =>
  new Set([
    ...normalize(text).split(" ").filter((t) => t.length > 1),
    ...compoundTokens(text),
  ]);

// Built once at import. 20 SKUs is trivial; at 20,000 this becomes a
// Postgres pg_trgm index instead — same interface, different engine.
const INDEX = catalogue.map((sku) => ({ sku, tokens: tokenize(searchableText(sku)) }));

const isNumeric = (t) => /^\d+$/.test(t);

function score(queryTokens, skuTokens) {
  let hits = 0;
  for (const t of queryTokens) {
    if (skuTokens.has(t)) hits += isNumeric(t) ? 3 : 1;
  }
  return hits / (queryTokens.size + 2);
}

// Escapes a value for safe use inside a RegExp literal.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The raw text still contains the quantity ("reta 300 cft") and that
// number is not a product attribute — it's how much the customer wants,
// not what the product is. Left in, it competes on equal footing with a
// genuine spec digit under the numeric token's 3x weight, and a
// coincidental quantity/dimension collision (a 300 cft order landing on
// a 300x600mm tile) can outscore the word that actually matches. Strip
// the quantity out of the text specifically before it becomes a token.
function stripQuantity(text, quantity) {
  if (quantity == null) return text;
  return String(text ?? "").replace(new RegExp(`\\b${escapeRegex(quantity)}\\b`, "g"), " ");
}

// True when the extracted spec and a candidate's own catalogue spec share
// no numeric substring — "12mm" vs "8 mm" — so a fact the extractor was
// confident about can never be silently outranked instead of excluded.
// Doesn't fire when either side has no digits: a non-dimensional spec
// ("Pillar Cock") isn't something this check can contradict.
// Pulled via a direct regex, not tokenize() — tokenize() drops
// single-character tokens (it's built to discard a stray "x" joiner from
// "2x2"), which would also silently drop a single-digit spec like "8".
function specContradicts(lineSpec, candidateSpec) {
  if (!lineSpec || !candidateSpec) return false;
  const lineNums = String(lineSpec).match(/\d+/g) ?? [];
  const candNums = String(candidateSpec).match(/\d+/g) ?? [];
  if (!lineNums.length || !candNums.length) return false;
  return !lineNums.some((n) => candNums.includes(n));
}

export function findCandidates(line, limit = 5) {
  // Fields the extractor was confident about get repeated, so they
  // count twice. Deliberate up-weighting of known facts.
  const query = [stripQuantity(line.raw_text, line.quantity), line.brand, line.spec, line.category]
    .filter(Boolean).join(" ");
  const qTokens = tokenize(query);

  const ranked = INDEX
    .map(({ sku, tokens }) => ({
      sku_code: sku.sku_code,
      label: `${sku.brand} ${sku.product}`,
      score: Number(score(qTokens, tokens).toFixed(3)),
      spec: sku.spec, // used to filter below, stripped before returning
    }))
    .sort((a, b) => b.score - a.score);

  // Filter on facts that were extracted; rank only on what's unknown.
  // A candidate below the confidence floor, or whose own spec contradicts
  // a spec the extractor was confident about, is not a real alternative —
  // it never reaches a human as an option, and never counts toward the
  // ambiguity margin below either.
  const candidates = ranked
    .filter((c) => c.score >= MIN_SCORE)
    .filter((c) => !specContradicts(line.spec, c.spec))
    .slice(0, limit)
    .map(({ spec, ...rest }) => rest);

  const [top, second] = candidates;
  let verdict;

  if (!top) {
    verdict = "no_match";            // nothing cleared the floor, or everything left contradicted a known spec
  } else if (line.missing?.length) {
    verdict = "ambiguous";           // extractor already told us a fact is absent
  } else if (second && (top.score - second.score) / top.score < AMBIGUITY_MARGIN) {
    verdict = "ambiguous";           // two candidates too close to separate
  } else {
    verdict = "matched";
  }

  return { raw_text: line.raw_text, verdict, candidates };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = JSON.parse(
    readFileSync(new URL("../data/sample-lines.json", import.meta.url))
  );
  for (const line of lines) {
    const r = findCandidates(line);
    console.log(`\n"${r.raw_text}"  →  ${r.verdict.toUpperCase()}`);
    console.table(r.candidates);
  }
}
