import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { generateObject } from "ai";
import { z } from "zod";
import type { Message, Recommendation } from "@indeedee/shared";
import type { RuleInput, RuleOutput } from "./rules.js";
import { recommendWithRules } from "./rules.js";

const BrainOutputSchema = z.object({
  action: z.enum([
    "reply",
    "create_task",
    "link_task",
    "delegate",
    "archive",
    "needs_context",
  ]),
  rationale: z.string().min(10).max(500),
  needsContext: z.boolean(),
  contextQuestion: z.string().optional(),
  taskTitle: z.string().optional(),
  draftBody: z.string().optional(),
});

export type BrainMode = "bedrock" | "rules";

export function resolveBrainMode(): BrainMode {
  const mode = process.env.INDEEDEE_BRAIN_MODE?.toLowerCase();
  if (mode === "rules") return "rules";
  if (mode === "bedrock") return isBedrockConfigured() ? "bedrock" : "rules";
  return isBedrockConfigured() ? "bedrock" : "rules";
}

export function isBedrockConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.BEDROCK_CHAT_MODEL,
  );
}

function buildPrompt(input: RuleInput): string {
  const { message, ragHits, prefs, style } = input;
  const ragBlock =
    ragHits.length ?
      ragHits
        .map(
          (h, i) =>
            `${i + 1}. [${h.sourceType}] ${h.title ?? "untitled"}: ${h.text.slice(0, 280)}`,
        )
        .join("\n")
    : "No indexed context yet.";

  const prefBlock =
    prefs.length ?
      prefs.map((p, i) => `${i + 1}. ${p.body.slice(0, 200)}`).join("\n")
    : "No stored preferences.";

  const styleBlock =
    style.length ?
      style.map((s, i) => `${i + 1}. ${s.slice(0, 300)}`).join("\n")
    : "No outbound style examples yet.";

  return [
    "You are Indeedee, a chief-of-staff communication agent.",
    "Recommend one action per inbound message and draft a style-matched reply when appropriate.",
    "Actions: reply, create_task, link_task, delegate, archive, needs_context.",
    "Use needs_context when the message is ambiguous and RAG has no useful context.",
    "Use create_task when the sender explicitly asks for a follow-up task.",
    "Use archive for FYI / no-action messages.",
    "Drafts should be concise, professional, and match the executive's style examples.",
    "",
    `Channel: ${message.channel}`,
    `From: ${message.sender.displayName ?? message.sender.handle} <${message.sender.handle}>`,
    `Subject: ${message.subject ?? "(none)"}`,
    `Body:\n${message.bodyText.slice(0, 2000)}`,
    "",
    "Retrieved context:",
    ragBlock,
    "",
    "Preferences:",
    prefBlock,
    "",
    "Style examples (outbound corpus):",
    styleBlock,
    "",
    "Return JSON only via the schema. Include draftBody for reply and create_task.",
  ].join("\n");
}

export async function recommendWithBedrock(input: RuleInput): Promise<RuleOutput & { mode: "bedrock" }> {
  const modelId = process.env.BEDROCK_CHAT_MODEL ?? "amazon.nova-lite-v1:0";
  const region = process.env.AWS_REGION ?? "us-east-2";
  const provider = createAmazonBedrock({ region });

  const { object } = await generateObject({
    model: provider(modelId),
    schema: BrainOutputSchema,
    prompt: buildPrompt(input),
    temperature: 0.2,
  });

  const fallback = recommendWithRules(input);
  const action = object.action as Recommendation["action"];
  const needsContext = object.needsContext || action === "needs_context";

  return {
    action,
    rationale: object.rationale,
    needsContext,
    contextQuestion:
      needsContext ?
        object.contextQuestion ?? "Which project or context should I use for this reply?"
      : undefined,
    topicKey: fallback.topicKey,
    taskTitle: object.taskTitle ?? fallback.taskTitle,
    taskDetail: fallback.taskDetail,
    draftBody:
      object.draftBody ??
      (action === "reply" || action === "create_task" ? fallback.draftBody : undefined),
    mode: "bedrock",
  };
}

export async function recommend(input: RuleInput): Promise<RuleOutput & { mode: BrainMode }> {
  if (resolveBrainMode() === "bedrock") {
    try {
      return await recommendWithBedrock(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[indeedee/brain] Bedrock failed, falling back to rules:", msg);
    }
  }
  return { ...recommendWithRules(input), mode: "rules" };
}
