import { describe, expect, it, afterEach } from "vitest";
import type { Message } from "@indeedee/shared";
import {
  inferTopicKey,
  isBedrockConfigured,
  recommend,
  recommendWithRules,
  resolveBrainMode,
} from "@indeedee/brain";
import { cover } from "./manifest.js";

const sampleMessage = (body: string): Message => ({
  id: "m1",
  ownerId: "o1",
  channel: "email",
  accountHandle: "exec@co.com",
  threadId: "t1",
  externalId: "e1",
  externalThreadId: "et1",
  direction: "inbound",
  sender: { handle: "alice@partner.com", displayName: "Alice" },
  recipients: [{ handle: "exec@co.com" }],
  subject: "Meeting",
  bodyText: body,
  sentAt: new Date().toISOString(),
  attachments: [],
  answeredStatus: "pending",
});

describe("AC-16 rule-based recommendation", () => {
  it("recommends reply for a direct question", () => {
    cover("AC-16");
    const out = recommendWithRules({
      message: sampleMessage("Can we meet Tuesday about the Q3 board deck?"),
      ragHits: [],
      prefs: [],
      style: [],
    });
    expect(out.action).toBe("reply");
    expect(out.rationale).toContain("reply");
    expect(out.draftBody).toBeTruthy();
  });

  it("recommends needs_context when uncertain and no RAG hits", () => {
    cover("AC-32");
    const out = recommendWithRules({
      message: sampleMessage("This confidential legal term sheet needs your input."),
      ragHits: [],
      prefs: [],
      style: [],
    });
    expect(out.action).toBe("needs_context");
    expect(out.needsContext).toBe(true);
    expect(out.contextQuestion).toBeTruthy();
  });

  it("recommends create_task when sender asks for a task", () => {
    const out = recommendWithRules({
      message: sampleMessage('Please create a task "Follow up with investor" by Friday.'),
      ragHits: [],
      prefs: [],
      style: [],
    });
    expect(out.action).toBe("create_task");
    expect(out.taskTitle).toContain("Follow up with investor");
  });
});

describe("AC-15 style learning", () => {
  it("drafts incorporate style corpus sign-off", () => {
    cover("AC-15");
    const out = recommendWithRules({
      message: sampleMessage("Quick question on the press release."),
      ragHits: [],
      prefs: [],
      style: ["Best,\nExecutive"],
    });
    expect(out.draftBody).toContain("Best,");
  });
});

describe("AC-17 style-matched drafts", () => {
  it("draft body reflects retrieved RAG context", () => {
    cover("AC-17");
    const out = recommendWithRules({
      message: sampleMessage("What's the status on the board deck?"),
      ragHits: [{ sourceType: "org", title: "Board deck", text: "Board deck ships July 20" }],
      prefs: [{ body: "Keep replies under three sentences" }],
      style: [],
    });
    expect(out.draftBody).toContain("Board deck ships");
    expect(out.draftBody).toContain("Preference");
  });
});

describe("Bedrock brain configuration", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("defaults to rules when AWS credentials are absent", () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.INDEEDEE_BRAIN_MODE;
    expect(isBedrockConfigured()).toBe(false);
    expect(resolveBrainMode()).toBe("rules");
  });

  it("selects bedrock mode when forced and credentials are present", () => {
    process.env.INDEEDEE_BRAIN_MODE = "bedrock";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.BEDROCK_CHAT_MODEL = "amazon.nova-lite-v1:0";
    expect(resolveBrainMode()).toBe("bedrock");
  });

  it("falls back to rules when Bedrock invocation fails", async () => {
    process.env.INDEEDEE_BRAIN_MODE = "bedrock";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.BEDROCK_CHAT_MODEL = "amazon.nova-lite-v1:0";

    const out = await recommend({
      message: sampleMessage("Can we meet Tuesday?"),
      ragHits: [],
      prefs: [],
      style: [],
    });
    expect(out.mode).toBe("rules");
    expect(out.action).toBe("reply");
    expect(out.draftBody).toBeTruthy();
  });
});

describe("topic linking", () => {
  it("infers stable topic keys from sender and subject", () => {
    const key = inferTopicKey(sampleMessage("hello"));
    expect(key).toContain("alice-partner-com");
    expect(key).toContain("meeting");
  });
});
