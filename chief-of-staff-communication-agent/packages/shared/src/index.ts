export {
  ActionSchema,
  AttachmentSchema,
  ChannelSchema,
  DashboardMetricsSchema,
  PersonSummarySchema,
  DraftSchema,
  MessageSchema,
  ParticipantSchema,
  RagChunkSchema,
  RagSourceTypeSchema,
  RecommendationSchema,
  type Action,
  type Attachment,
  type Channel,
  type DashboardMetrics,
  type PersonSummary,
  type Draft,
  type Message,
  type Participant,
  type RagChunk,
  type RagSourceType,
  type Recommendation,
} from "./domain.js";

export type { Connector, InboundMessage, SendRequest, SendResult } from "./connector.js";

export {
  ApprovalRequiredError,
  assertSendAllowed,
  countOverdue,
  isOverdue,
  type DraftSendStatus,
} from "./guards.js";

export {
  CHANNEL_CATALOG,
  buildAsanaIntegrationPayload,
  buildConnectPayload,
  getCatalogEntry,
  type ChannelCatalogEntry,
  type ChannelConnectKind,
  type CredentialFieldDef,
} from "./channel-catalog.js";
