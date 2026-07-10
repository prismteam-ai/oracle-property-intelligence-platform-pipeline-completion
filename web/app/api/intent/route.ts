import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SIGNALS, UNSUPPORTED, SIGNAL_IDS, UNSUPPORTED_IDS } from "@/lib/intent";

/**
 * Intent-parsing agent. A dedicated step (separate from SQL execution and the
 * summary) that turns a natural-language question into STRUCTURED intent over a
 * fixed signal vocabulary. The UI shows this parsed intent and the same
 * structure builds the query — nothing hidden, nothing faked.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

const SIGNAL_MENU = Object.values(SIGNALS)
  .map((s) => `- ${s.id}: ${s.label}${s.note ? ` (${s.kind})` : ""}`)
  .join("\n");
const UNSUPPORTED_MENU = Object.entries(UNSUPPORTED)
  .map(([id, reason]) => `- ${id}: ${reason}`)
  .join("\n");

const SYSTEM = `You parse a property-search question about Palo Alto into structured intent.
Map the question ONLY to these known signals (choose the ids that apply; they are ANDed):
${SIGNAL_MENU}

If the question asks for something in this "unsupported" list, DO NOT invent a signal —
put it under unsupported with the matching id:
${UNSUPPORTED_MENU}

Rules:
- "roofs older than 15 years" -> roof_over_15. "newer/recently reroofed" -> roof_recent.
- "no sale in N years", "hasn't sold", "sold", "long-held" -> criteria dormant_10yr (a PROXY) AND
  ALSO add unsupported exact_sale_date, because true sale dates are not available.
  (For "long-held / aging" with no explicit sale wording, dormant_10yr alone is fine.)
- "regional / out-of-area / absentee / who owns" -> unsupported regional_owner.
- "near transit/bus/train" -> near_transit. "near Starbucks/coffee" -> near_starbucks.
- "water view / waterfront" -> water_view.
- Keep summary to one plain sentence describing what will be searched.`;

export async function POST(req: NextRequest) {
  let question = "";
  try {
    question = String((await req.json()).question ?? "");
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const msg = await client().messages.create({
      model: MODEL,
      max_tokens: 700,
      system: SYSTEM,
      tools: [
        {
          name: "emit_intent",
          description: "Return the structured intent for the question.",
          input_schema: {
            type: "object",
            properties: {
              criteria: {
                type: "array",
                items: { type: "string", enum: SIGNAL_IDS },
                description: "Signal ids that apply (ANDed).",
              },
              unsupported: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", enum: UNSUPPORTED_IDS },
                    requested: { type: "string", description: "What the user asked for, in their words." },
                  },
                  required: ["id", "requested"],
                },
              },
              summary: { type: "string" },
            },
            required: ["criteria", "unsupported", "summary"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "emit_intent" },
      messages: [{ role: "user", content: question }],
    });

    const tool = msg.content.find((c) => c.type === "tool_use");
    if (!tool || tool.type !== "tool_use") {
      return NextResponse.json({ error: "no intent produced" }, { status: 502 });
    }
    return NextResponse.json(tool.input);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /ANTHROPIC_API_KEY/.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
