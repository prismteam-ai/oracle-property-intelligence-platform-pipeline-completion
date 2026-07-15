/**
 * ToolLoopAgent tool contracts (ash / build-ai-agents).
 * The Lambda handler registers these tools — none may send without approval.
 */
import { z } from "zod";

export const RetrieveContextInput = z.object({
  query: z.string(),
  messageId: z.string().optional(),
  topK: z.number().int().min(1).max(20).default(8),
});

export const RecommendActionInput = z.object({
  messageId: z.string(),
  force: z.boolean().default(false),
});

export const DraftReplyInput = z.object({
  messageId: z.string(),
  additionalContext: z.string().optional(),
});

export const ProposeAsanaTaskInput = z.object({
  messageId: z.string(),
  title: z.string(),
  notes: z.string().optional(),
  dueOn: z.string().optional(),
});

export const ApproveSendInput = z.object({
  draftId: z.string(),
  editedBody: z.string().optional(),
});

export const IndeedeeToolNames = [
  "retrieve_context",
  "recommend_action",
  "draft_reply",
  "propose_asana_task",
  "approve_and_send",
  "list_pending",
  "dashboard_stats",
] as const;

export type IndeedeeToolName = (typeof IndeedeeToolNames)[number];
