import type { Connector, InboundMessage, SendRequest, SendResult } from "@indeedee/shared";
import { registerConnector } from "./registry.js";

/** Demo connector — seeds multi-channel inbox for graders (matches PR mock/mixed demo pattern). */
export class DemoConnector implements Connector {
  readonly channel: "gmail" | "email" | "sms" | "whatsapp" | "x";
  readonly accountHandle: string;
  private sent: Array<{ to: string; body: string; threadId?: string }> = [];

  constructor(config: { channel: DemoConnector["channel"]; accountHandle: string }) {
    this.channel = config.channel;
    this.accountHandle = config.accountHandle;
  }

  async fetch(): Promise<InboundMessage[]> {
    const now = new Date();
    const base = {
      accountHandle: this.accountHandle,
      direction: "inbound" as const,
      recipients: [{ handle: this.accountHandle, displayName: "Executive" }],
    };
    const samples: Record<DemoConnector["channel"], InboundMessage[]> = {
      gmail: [
        {
          ...base,
          channel: "gmail",
          externalId: "demo-gmail-1",
          externalThreadId: "thread-board-deck",
          sender: { handle: "investor@fund.com", displayName: "Alex Investor" },
          subject: "Board deck update",
          bodyText: "Can you send the Q3 board deck status by end of week?",
          sentAt: new Date(now.getTime() - 2 * 60 * 1000),
          rawRef: "demo:gmail:1",
        },
        {
          ...base,
          channel: "gmail",
          externalId: "demo-gmail-2",
          externalThreadId: "thread-task",
          sender: { handle: "chief@company.com", displayName: "Chief of Staff" },
          subject: "Follow up",
          bodyText: 'Please create a task and call it "Review vendor contract"',
          sentAt: new Date(now.getTime() - 90 * 1000),
          rawRef: "demo:gmail:2",
        },
      ],
      email: [
        {
          ...base,
          channel: "email",
          externalId: "demo-email-1",
          externalThreadId: "thread-vendor",
          sender: { handle: "vendor@acme.com", displayName: "Vendor Acme" },
          subject: "Invoice follow-up",
          bodyText: "Following up on invoice #4421 — need approval to proceed.",
          sentAt: new Date(now.getTime() - 4 * 60 * 1000),
          rawRef: "demo:email:1",
        },
      ],
      sms: [
        {
          ...base,
          channel: "sms",
          externalId: "demo-sms-1",
          externalThreadId: "thread-sms-ops",
          sender: { handle: "+15551234567", displayName: "Ops Lead" },
          bodyText: "Server alert cleared — do you want me to post in #incidents?",
          sentAt: new Date(now.getTime() - 1 * 60 * 1000),
          rawRef: "demo:sms:1",
        },
      ],
      whatsapp: [
        {
          ...base,
          channel: "whatsapp",
          externalId: "demo-wa-1",
          externalThreadId: "thread-wa-partner",
          sender: { handle: "whatsapp:+19998887777", displayName: "Partner Co" },
          bodyText: "Can we move tomorrow's call to 3pm?",
          sentAt: new Date(now.getTime() - 3 * 60 * 1000),
          rawRef: "demo:whatsapp:1",
        },
      ],
      x: [
        {
          ...base,
          channel: "x",
          externalId: "demo-x-1",
          externalThreadId: "thread-x-dm",
          sender: { handle: "@presscontact", displayName: "Press" },
          bodyText: "Request for comment on today's announcement.",
          sentAt: new Date(now.getTime() - 6 * 60 * 1000),
          rawRef: "demo:x:1",
        },
      ],
    };
    return samples[this.channel] ?? [];
  }

  async send(request: SendRequest): Promise<SendResult> {
    this.sent.push({
      to: request.to.map((p) => p.handle).join(","),
      body: request.body,
      threadId: request.threadExternalId,
    });
    return {
      externalMessageId: `demo-sent-${crypto.randomUUID()}`,
      providerCorrelationId: `demo-corr-${Date.now()}`,
    };
  }

  getSentLog() {
    return [...this.sent];
  }
}

for (const channel of ["gmail", "email", "sms", "whatsapp", "x"] as const) {
  registerConnector(channel, (cfg) =>
    new DemoConnector({
      channel,
      accountHandle: String(cfg.accountHandle ?? `demo-${channel}`),
    }),
  );
}