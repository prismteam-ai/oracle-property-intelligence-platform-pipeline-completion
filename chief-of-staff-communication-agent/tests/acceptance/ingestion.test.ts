import { describe, expect, it } from "vitest";
import {
  AttachmentSchema,
  MessageSchema,
  ParticipantSchema,
  RagSourceTypeSchema,
} from "@indeedee/shared";
import { cover } from "./manifest.js";

const sampleMessage = {
  id: "msg-1",
  ownerId: "owner-a",
  channel: "gmail" as const,
  accountHandle: "exec@company.com",
  threadId: "thread-1",
  externalId: "ext-1",
  externalThreadId: "ext-thread-1",
  direction: "inbound" as const,
  sender: { handle: "sender@example.com", displayName: "Sender" },
  recipients: [{ handle: "exec@company.com" }],
  subject: "Update",
  bodyText: "Need a status update",
  sentAt: new Date().toISOString(),
  attachments: [{ id: "att-1", filename: "brief.pdf", mimeType: "application/pdf" }],
  rawRef: "gmail:msg:abc",
  answeredStatus: "pending" as const,
};

describe("AC-10 ingest normalized message shape", () => {
  it("stores threads, participants, timestamps, attachments, and provenance", () => {
    cover("AC-10");
    const parsed = MessageSchema.parse(sampleMessage);
    expect(parsed.threadId).toBe("thread-1");
    expect(parsed.sender.displayName).toBe("Sender");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.rawRef).toMatch(/^gmail:/);
    expect(ParticipantSchema.parse(parsed.sender).handle).toBeTruthy();
    expect(AttachmentSchema.parse(parsed.attachments[0]).filename).toBe("brief.pdf");
  });
});

describe("AC-11 centralized knowledge layer", () => {
  it("uses one message schema for all channels", () => {
    cover("AC-11");
    for (const channel of ["gmail", "sms", "x"] as const) {
      const msg = MessageSchema.parse({ ...sampleMessage, channel });
      expect(msg.channel).toBe(channel);
      expect(msg.rawRef).toBeTruthy();
    }
  });
});

describe("AC-13 preserve conversation history", () => {
  it("retains outbound messages for style corpus via direction field", () => {
    cover("AC-13");
    const outbound = MessageSchema.parse({
      ...sampleMessage,
      direction: "outbound",
      answeredStatus: "no_reply_needed",
    });
    expect(outbound.direction).toBe("outbound");
  });
});

describe("AC-12 RAG source types", () => {
  it("indexes communication, Asana, preferences, and org knowledge", () => {
    cover("AC-12");
    const types = RagSourceTypeSchema.options;
    expect(types).toContain("message");
    expect(types).toContain("asana_task");
    expect(types).toContain("preference");
    expect(types).toContain("org_knowledge");
    expect(types).toContain("style_example");
  });

  it.skip("integration: retrieval returns hits from each source type", () => {
    cover("AC-12");
  });
});

describe("AC-14 cross-channel linking", () => {
  it.skip("integration: same person/topic links across channels", () => {
    cover("AC-14");
  });
});

describe("AC-21 track answered status", () => {
  it("message schema includes answered state and timestamp", () => {
    cover("AC-21");
    const answered = MessageSchema.parse({
      ...sampleMessage,
      answeredStatus: "answered",
      answeredAt: new Date().toISOString(),
    });
    expect(answered.answeredStatus).toBe("answered");
    expect(answered.answeredAt).toBeTruthy();
  });
});
