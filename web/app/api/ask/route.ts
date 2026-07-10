import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { PROPERTIES_SCHEMA_PROMPT } from "@/lib/schema-prompt";

/**
 * Stateless agent endpoint. Two phases so the SQL executes in the browser's
 * DuckDB-WASM (no server database):
 *   phase "plan"   {question}                 -> { sql, reasoning }
 *   phase "answer" {question, sql, rows, ...}  -> { answer }
 * The client runs the SQL between the two calls.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    if (body.phase === "plan") return await plan(body.question);
    if (body.phase === "answer") return await answer(body);
    return NextResponse.json({ error: "unknown phase" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /ANTHROPIC_API_KEY/.test(msg) ? 503 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

async function plan(question: string) {
  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: PROPERTIES_SCHEMA_PROMPT,
    tools: [
      {
        name: "run_query",
        description: "Provide the single SELECT to run over `properties`, and short reasoning.",
        input_schema: {
          type: "object",
          properties: {
            sql: { type: "string", description: "One read-only SELECT/CTE over `properties`." },
            reasoning: { type: "string", description: "One or two sentences on the approach and any data caveat." },
          },
          required: ["sql", "reasoning"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "run_query" },
    messages: [{ role: "user", content: String(question ?? "") }],
  });

  const tool = msg.content.find((c) => c.type === "tool_use");
  if (!tool || tool.type !== "tool_use") {
    return NextResponse.json({ error: "no query produced" }, { status: 502 });
  }
  const input = tool.input as { sql: string; reasoning: string };
  return NextResponse.json({ sql: input.sql, reasoning: input.reasoning });
}

async function answer(body: {
  question: string;
  sql: string;
  rowCount: number;
  rows: Record<string, unknown>[];
}) {
  const sample = JSON.stringify(body.rows.slice(0, 30), null, 0);
  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: PROPERTIES_SCHEMA_PROMPT,
    messages: [
      {
        role: "user",
        content:
          `Question: ${body.question}\n\n` +
          `SQL run over \`properties\`:\n${body.sql}\n\n` +
          `Total matching rows: ${body.rowCount}. Sample (up to 30):\n${sample}\n\n` +
          `Write a concise answer for a property analyst. State the count, give a few concrete example ` +
          `properties (address + APN), name the data sources, and clearly flag any proxy/gap caveat ` +
          `(no-sale proxy, owner data gap, water-view heuristic). Do not invent data not in the rows.`,
      },
    ],
  });
  const text = msg.content
    .filter((c) => c.type === "text")
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
  return NextResponse.json({ answer: text });
}
