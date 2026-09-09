// Reconciles a customer's informal unit word against a SKU's canonical
// unit of measure. Most of the WhatsApp vocabulary here ("bora", "nos",
// "cft") is just a synonym for a uom the catalogue already spells one
// way — this is normalization, not arithmetic conversion. A genuine
// mismatch (a unit that doesn't map to this SKU's uom at all) is never
// silently forced through; it comes back flagged for a human to see,
// the same "propose, flag exceptions" boundary as everything upstream.
const SYNONYMS = {
  bora: "bag",
  bori: "bag",
  bag: "bag",
  bags: "bag",
  ton: "tonne",
  tons: "tonne",
  tonne: "tonne",
  tonnes: "tonne",
  nos: "piece",
  no: "piece",
  piece: "piece",
  pieces: "piece",
  pc: "piece",
  pcs: "piece",
  cft: "cubic ft",
  "cubic ft": "cubic ft",
  box: "box",
  boxes: "box",
  coil: "coil",
  coils: "coil",
};

export function reconcileUnit(extractedUnit, catalogUom) {
  if (!extractedUnit || !catalogUom) {
    return { ok: false, resolvedUnit: null, note: "unit missing on one side" };
  }

  const key = String(extractedUnit).trim().toLowerCase();
  const target = String(catalogUom).trim().toLowerCase();
  const resolved = SYNONYMS[key];

  if (resolved && resolved === target) {
    return { ok: true, resolvedUnit: resolved, note: null };
  }

  return {
    ok: false,
    resolvedUnit: resolved ?? null,
    note: resolved
      ? `customer said "${extractedUnit}" (${resolved}), catalogue sells this SKU by "${catalogUom}" — mismatch`
      : `unrecognized unit "${extractedUnit}", catalogue uom is "${catalogUom}"`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = [
    ["bora", "bag"],
    ["ton", "tonne"],
    ["nos", "piece"],
    ["cft", "cubic ft"],
    ["box", "box"],
    ["coil", "coil"],
    ["sqft", "bag"],   // deliberate mismatch: wrong dimension entirely
    ["ton", "piece"],  // deliberate mismatch: known unit, wrong target uom
    [null, "bag"],     // deliberate: missing unit
  ];
  for (const [u, uom] of cases) {
    console.log(`${String(u).padEnd(8)} vs ${uom.padEnd(10)} ->`, reconcileUnit(u, uom));
  }
}
