import { readFileSync } from "fs";

export const catalogue = JSON.parse(
  readFileSync(new URL("../data/sku-master.json", import.meta.url))
);

// Flattens every SKU into one searchable line of text.
// Layer 2's matcher will search against this, not the raw object.
export function searchableText(sku) {
  return [sku.brand, sku.product, sku.spec, ...sku.aliases]
    .join(" ")
    .toLowerCase();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const byCategory = {};
  for (const s of catalogue) {
    byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
  }
  console.log(`${catalogue.length} SKUs loaded`);
  console.table(byCategory);
}
