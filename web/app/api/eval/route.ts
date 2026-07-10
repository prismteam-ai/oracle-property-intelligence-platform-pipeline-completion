import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM-as-judge for search relevance. Given the user's question, the criteria the
 * system applied, and a sample of the returned rows, it scores how relevant the
 * results are (0–5) with a verdict + reason. Independent of the intent agent, so
 * it catches intent-mapping mistakes end to end.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

const SYSTEM = `You are a strict evaluator of a property-search system for Palo Alto.
Given a user question, the criteria the system applied, and a sample of the returned
properties, judge how RELEVANT the results are to what the user actually asked.

Scoring (0–5):
- 5 = results exactly match the intent of the question.
- 3 = partially relevant (missed or added a condition).
- 0 = irrelevant (searched for the wrong thing).

Be aware of legitimate limitations the system is honest about (not penalties if handled):
- "no sale in 10 years" is answered by a permit-dormancy PROXY (sale dates aren't open data in CA).
- "regional/out-of-area owner" cannot be answered (owner mailing address isn't open data) — the
  system should flag it, not fake it. If the question ONLY asked for an unavailable thing and the
  system correctly returned nothing while flagging it, that is relevant handling (score high).
- "water view" is a proximity heuristic.
Judge relevance of the SEARCH to the QUESTION, accounting for these documented limits.`;

export async function POST(req: NextRequest) {
  let body: {
    question?: string;
    criteria?: string[];
    unsupported?: string[];
    rowCount?: number;
    rows?: Record<string, unknown>[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const sample = JSON.stringify((body.rows ?? []).slice(0, 8));
    const msg = await client().messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM,
      tools: [
        {
          name: "judge",
          description: "Return the relevance judgement.",
          input_schema: {
            type: "object",
            properties: {
              relevance: { type: "number", description: "0 to 5" },
              verdict: { type: "string", enum: ["relevant", "partial", "irrelevant"] },
              reason: { type: "string", description: "One sentence." },
            },
            required: ["relevance", "verdict", "reason"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "judge" },
      messages: [
        {
          role: "user",
          content:
            `Question: ${body.question}\n` +
            `Applied criteria: ${JSON.stringify(body.criteria ?? [])}\n` +
            `Flagged unavailable: ${JSON.stringify(body.unsupported ?? [])}\n` +
            `Total matches: ${body.rowCount}\n` +
            `Sample rows: ${sample}`,
        },
      ],
    });
    const tool = msg.content.find((c) => c.type === "tool_use");
    if (!tool || tool.type !== "tool_use") {
      return NextResponse.json({ error: "no judgement" }, { status: 502 });
    }
    return NextResponse.json(tool.input);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /ANTHROPIC_API_KEY/.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
