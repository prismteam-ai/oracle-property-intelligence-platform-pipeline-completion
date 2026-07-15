import type { Message, Recommendation } from "@indeedee/shared";
import {
  getRecommendation,
  getStyleCorpus,
  indexRagChunk,
  listKnowledge,
  saveDraft,
  saveRecommendation,
  searchRag,
  upsertTopicLink,
} from "@indeedee/db";
import { inferTopicKey, recommendWithRules } from "./rules.js";
import { recommend, resolveBrainMode } from "./bedrock.js";

export { recommend, resolveBrainMode, isBedrockConfigured, recommendWithBedrock } from "./bedrock.js";
export { inferTopicKey, recommendWithRules } from "./rules.js";

export async function processMessage(ownerId: string, message: Message) {
  const existing = await getRecommendation(ownerId, message.id);
  if (existing) return { skipped: true as const, messageId: message.id };

  const ragHits = await searchRag(ownerId, `${message.subject ?? ""} ${message.bodyText}`, 5);
  const prefs = await listKnowledge(ownerId);
  const style = await getStyleCorpus(ownerId);

  const brain = await recommend({
    message,
    ragHits: ragHits.map((h) => ({
      sourceType: h.sourceType,
      title: h.title,
      text: h.text,
    })),
    prefs,
    style,
  });

  const recId = crypto.randomUUID();
  const now = new Date().toISOString();
  const rec: Omit<Recommendation, "ownerId"> = {
    id: recId,
    messageId: message.id,
    action: brain.action,
    rationale: brain.rationale,
    needsContext: brain.needsContext,
    contextQuestion: brain.contextQuestion,
    topicKey: brain.topicKey ?? inferTopicKey(message),
    taskTitle: brain.taskTitle,
    taskDetail: brain.taskDetail,
    createdAt: now,
  };
  await saveRecommendation(ownerId, rec);
  if (rec.topicKey) await upsertTopicLink(ownerId, rec.topicKey, message.id);

  await indexRagChunk(ownerId, "message", message.id, message.subject, message.bodyText);

  if (brain.draftBody && (brain.action === "reply" || brain.action === "create_task")) {
    await saveDraft(ownerId, {
      id: crypto.randomUUID(),
      messageId: message.id,
      recommendationId: recId,
      body: brain.draftBody,
      status: "pending_approval",
      createdAt: now,
    });
  }

  return { messageId: message.id, recommendation: rec, draftBody: brain.draftBody, brainMode: brain.mode };
}

export async function processPending(ownerId: string) {
  const { listMessages } = await import("@indeedee/db");
  const pending = await listMessages(ownerId, { pendingOnly: true });
  const results = [];
  for (const msg of pending.sort((a, b) => b.sentAt.localeCompare(a.sentAt))) {
    if (msg.direction !== "inbound") continue;
    results.push(await processMessage(ownerId, msg));
  }
  return results;
}

export async function redraftWithContext(ownerId: string, messageId: string, context: string) {
  const { getMessage, addKnowledge, clearBrainOutputForMessage } = await import("@indeedee/db");
  const msg = await getMessage(ownerId, messageId);
  if (!msg) throw new Error("Message not found");
  await addKnowledge(ownerId, "preference", "User context", context);
  await clearBrainOutputForMessage(ownerId, messageId);
  return processMessage(ownerId, { ...msg, bodyText: `${msg.bodyText}\n\nContext: ${context}` });
}
