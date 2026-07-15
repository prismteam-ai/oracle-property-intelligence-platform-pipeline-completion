import type { Attachment, Channel, Participant } from "./domain.js";

/**
 * Chatot-shaped connector contract: fetch inbound/outbound history and send
 * approved replies. One implementation per channel; register in connectors package.
 */
export interface InboundMessage {
  channel: Channel;
  accountHandle: string;
  externalId: string;
  externalThreadId: string;
  direction: "inbound" | "outbound";
  sender: Participant;
  recipients: Participant[];
  subject?: string;
  bodyText: string;
  sentAt: Date;
  attachments?: Attachment[];
  rawRef?: string;
}

export interface SendRequest {
  to: Participant[];
  body: string;
  threadExternalId?: string;
  subject?: string;
}

export interface SendResult {
  externalMessageId: string;
  providerCorrelationId: string;
}

export interface Connector {
  readonly channel: Channel;
  readonly accountHandle: string;

  /** Pull messages since last sync cursor (idempotent upsert upstream). */
  fetch(): Promise<InboundMessage[]>;

  /** Send only after human approval — never called from the brain directly. */
  send(request: SendRequest): Promise<SendResult>;
}
