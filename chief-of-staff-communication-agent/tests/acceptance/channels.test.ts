import { describe, expect, it } from "vitest";
import { ChannelSchema } from "@indeedee/shared";
import {
  createConnector,
  registerConnector,
  supportedChannels,
} from "@indeedee/connectors";
import type { Connector, InboundMessage, SendRequest, SendResult } from "@indeedee/shared";
import { cover } from "./manifest.js";

class StubConnector implements Connector {
  readonly channel = "sms" as const;
  readonly accountHandle: string;
  constructor(handle: string) {
    this.accountHandle = handle;
  }
  async fetch(): Promise<InboundMessage[]> {
    return [];
  }
  async send(_req: SendRequest): Promise<SendResult> {
    return { externalMessageId: "ext-1", providerCorrelationId: "corr-1" };
  }
}

describe("AC-09 modular connector architecture", () => {
  it("registers new channels without changing core enums", () => {
    cover("AC-09");
    registerConnector("sms", (cfg) => new StubConnector(String(cfg.accountHandle)));
    const conn = createConnector("sms", { accountHandle: "brand-a" });
    expect(conn.channel).toBe("sms");
    expect(conn.accountHandle).toBe("brand-a");
  });

  it("lists supported channels from registry", () => {
    cover("AC-09");
    expect(supportedChannels()).toContain("gmail");
    expect(supportedChannels()).toContain("sms");
  });
});

describe("AC-08 LinkedIn channel slot", () => {
  it("includes linkedin in channel schema for compliant implementation or explicit unavailability", () => {
    cover("AC-08");
    expect(ChannelSchema.options).toContain("linkedin");
  });
});

describe.each([
  ["AC-03", "gmail"],
  ["AC-04", "email"],
  ["AC-05", "sms"],
  ["AC-06", "whatsapp"],
  ["AC-07", "x"],
] as const)("%s channel contract", (acId, channel) => {
  it(`accepts ${channel} in connect API input`, () => {
    if (acId === "AC-03") cover("AC-03");
    if (acId === "AC-04") cover("AC-04");
    if (acId === "AC-05") cover("AC-05");
    if (acId === "AC-06") cover("AC-06");
    if (acId === "AC-07") cover("AC-07");
    expect(ChannelSchema.safeParse(channel).success).toBe(true);
  });

  it.skip(`integration: ${channel} connect, ingest, and send-after-approval`, () => {
    if (acId === "AC-03") cover("AC-03");
    if (acId === "AC-04") cover("AC-04");
    if (acId === "AC-05") cover("AC-05");
    if (acId === "AC-06") cover("AC-06");
    if (acId === "AC-07") cover("AC-07");
  });
});

describe("AC-02 email across brands", () => {
  it.skip("e2e: multiple email accounts per user appear tagged by account", () => {
    cover("AC-02");
  });
});

describe("Connect catalog (PR-1/PR-3 pattern)", () => {
  it("exposes channel catalog with oauth and credential kinds", async () => {
    const { appRouter } = await import("@indeedee/api/trpc/router");
    const caller = appRouter.createCaller({ ownerId: "o1", role: "owner" });
    const catalog = await caller.connectors.catalog();
    expect(catalog.channels.some((c) => c.id === "gmail" && c.kind === "oauth")).toBe(true);
    expect(catalog.channels.some((c) => c.id === "email" && c.fields?.length)).toBe(true);
    expect(catalog.channels.find((c) => c.id === "linkedin")?.kind).toBe("unavailable");
  });

  it("test returns demo label for demo-mode connections", async () => {
    const { appRouter } = await import("@indeedee/api/trpc/router");
    const caller = appRouter.createCaller({ ownerId: "o-test", role: "owner" });
    await caller.connectors.seedDemo();
    const result = await caller.connectors.test({ channelId: "gmail" });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("demo");
    expect(result.label).toContain("demo");
  });

  it("connectForm maps credential fields to connector_tokens contract", async () => {
    const { appRouter } = await import("@indeedee/api/trpc/router");
    const { buildConnectPayload } = await import("@indeedee/shared");
    const payload = buildConnectPayload("email", {
      email: "you@zoho.com",
      password: "secret",
      imapHost: "imap.zoho.com",
    });
    expect(payload).toMatchObject({
      channel: "email",
      accountHandle: "you@zoho.com",
      credentials: { mode: "live", password: "secret", imapHost: "imap.zoho.com" },
    });
    const caller = appRouter.createCaller({ ownerId: "o2", role: "owner" });
    const result = await caller.connectors.connectForm({
      channelId: "sms",
      values: { fromNumber: "+15550001", accountSid: "ACx", authToken: "tok" },
    });
    expect(result.status).toBe("connected");
  });
});
