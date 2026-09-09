import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { catalogue } from "./catalogue.js";

const client = new Anthropic();
const CATEGORIES = [...new Set(catalogue.map((s) => s.category))];

const SYSTEM = `You extract order lines from construction material orders sent by
contractors in India. Messages may be English, Hindi or Hinglish, with typos.

Extract ONLY what the text actually states. Never infer a brand, grade or size
that is not written.

Allowed categories: ${CATEGORIES.join(", ")}

Return JSON with exactly this shape:
{
  "lines": [
    {
      "raw_text": "the original fragment, verbatim",
      "quantity": number or null,
      "unit": "unit as written, or null",
      "category": "one of the allowed categories, or null",
      "brand": "brand if stated, else null",
      "spec": "size or grade if stated, else null",
      "missing": ["brand", "spec"]
    }
  ],
  "notes": "anything about the message as a whole"
}

Rules:
- "missing" lists only the fields a distributor would need to pick one exact
  product. If the brand is written, brand is not missing.
- Never merge two different products into one line.
- Do not output SKU codes. You do not have the catalogue.`;

// Forced tool call instead of assistant-message prefill: claude-sonnet-5
// rejects prefill outright ("conversation must end with a user message"),
// and tool_choice is the more portable way to guarantee structured JSON
// across models anyway — it doesn't depend on a prompting trick holding.
const RECORD_LINES_TOOL = {
  name: "record_order_lines",
  description: "Record the order lines extracted from the message.",
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            raw_text: { type: "string" },
            quantity: { type: ["number", "null"] },
            unit: { type: ["string", "null"] },
            category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
            brand: { type: ["string", "null"] },
            spec: { type: ["string", "null"] },
            missing: { type: "array", items: { type: "string" } },
          },
          required: ["raw_text", "quantity", "unit", "category", "brand", "spec", "missing"],
        },
      },
      notes: { type: "string" },
    },
    required: ["lines", "notes"],
  },
};

export async function extract(orderText) {
  const res = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2000,
    system: SYSTEM,
    tools: [RECORD_LINES_TOOL],
    tool_choice: { type: "tool", name: "record_order_lines" },
    messages: [{ role: "user", content: orderText }],
  });
  const call = res.content.find((b) => b.type === "tool_use");
  if (!call) throw new Error("Model did not call record_order_lines");
  return call.input;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const orders = JSON.parse(
    readFileSync(new URL("../data/sample-orders.json", import.meta.url))
  );
  const which = Number(process.argv[2] ?? 0);
  console.log("INPUT:\n" + orders[which] + "\n");
  console.dir(await extract(orders[which]), { depth: null });
}
