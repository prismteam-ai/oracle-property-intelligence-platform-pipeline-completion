import { z } from "zod";

/** Supported communication channels (modular — add new values + connector impl). */
export const ChannelSchema = z.enum([
  "gmail",
  "email",
  "sms",
  "whatsapp",
  "x",
  "linkedin",
]);
export type Channel = z.infer<typeof ChannelSchema>;

export const ParticipantSchema = z.object({
  handle: z.string(),
  displayName: z.string().optional(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Normalized inbound/outbound message after connector ingest. */
export const MessageSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  channel: ChannelSchema,
  accountHandle: z.string(),
  threadId: z.string(),
  externalId: z.string(),
  externalThreadId: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  sender: ParticipantSchema,
  recipients: z.array(ParticipantSchema),
  subject: z.string().optional(),
  bodyText: z.string(),
  sentAt: z.string().datetime(),
  attachments: z.array(AttachmentSchema).default([]),
  rawRef: z.string().optional(),
  answeredStatus: z.enum(["pending", "answered", "no_reply_needed"]).default("pending"),
  answeredAt: z.string().datetime().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/** Brain output — one recommendation per inbound message. */
export const ActionSchema = z.enum([
  "reply",
  "create_task",
  "link_task",
  "delegate",
  "archive",
  "needs_context",
]);
export type Action = z.infer<typeof ActionSchema>;

export const RecommendationSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  ownerId: z.string(),
  action: ActionSchema,
  rationale: z.string(),
  needsContext: z.boolean(),
  contextQuestion: z.string().optional(),
  topicKey: z.string().optional(),
  taskTitle: z.string().optional(),
  taskDetail: z.string().optional(),
  taskDue: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const DraftSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  recommendationId: z.string(),
  ownerId: z.string(),
  body: z.string(),
  status: z.enum(["pending_approval", "approved", "rejected", "sent"]),
  createdAt: z.string().datetime(),
  sentAt: z.string().datetime().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

/** RAG corpus source types (espeon / build-rag-systems contract). */
export const RagSourceTypeSchema = z.enum([
  "message",
  "asana_task",
  "asana_comment",
  "preference",
  "org_knowledge",
  "style_example",
]);
export type RagSourceType = z.infer<typeof RagSourceTypeSchema>;

export const RagChunkSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  sourceType: RagSourceTypeSchema,
  sourceId: z.string(),
  title: z.string().optional(),
  textForContext: z.string(),
  metadata: z.record(z.unknown()).default({}),
});
export type RagChunk = z.infer<typeof RagChunkSchema>;

/** SLA dashboard aggregates. */
export const DashboardMetricsSchema = z.object({
  totalInbound: z.number(),
  answered: z.number(),
  pending: z.number(),
  overdue: z.number(),
  pendingApprovals: z.number(),
  medianResponseSeconds: z.number().optional(),
  pctUnderFiveMinutes: z.number().optional(),
  byChannel: z.record(z.number()),
});
export type DashboardMetrics = z.infer<typeof DashboardMetricsSchema>;

export const PersonSummarySchema = z.object({
  handle: z.string(),
  displayName: z.string().optional(),
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().datetime(),
  channels: z.array(ChannelSchema),
});
export type PersonSummary = z.infer<typeof PersonSummarySchema>;
