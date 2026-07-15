import type { Connector, InboundMessage, SendRequest, SendResult } from "@indeedee/shared";
import { registerConnector } from "./registry.js";
import { demoFetch, demoSend, isLiveCredentials } from "./lib/helpers.js";
import { twilioFetch, twilioSend } from "./lib/twilio-api.js";

function twilioConnector(channel: "sms" | "whatsapp") {
  return class TwilioConnector implements Connector {
    readonly channel = channel;
    readonly accountHandle: string;
    private credentials: Record<string, string>;

    constructor(config: { accountHandle: string; credentials?: Record<string, string> }) {
      this.accountHandle = config.accountHandle;
      this.credentials = config.credentials ?? {};
    }

    private isLive(): boolean {
      return (
        isLiveCredentials(this.credentials) &&
        Boolean(this.credentials.accountSid && this.credentials.authToken && this.credentials.fromNumber)
      );
    }

    async fetch(): Promise<InboundMessage[]> {
      if (!this.isLive()) {
        return demoFetch(channel, this.accountHandle);
      }
      return twilioFetch(channel, this.accountHandle, this.credentials);
    }

    async send(request: SendRequest): Promise<SendResult> {
      if (!this.isLive()) {
        return demoSend(channel, this.accountHandle, request);
      }
      return twilioSend(channel, this.credentials, request);
    }
  };
}

registerConnector("sms", (cfg) =>
  new (twilioConnector("sms"))({
    accountHandle: String(cfg.accountHandle),
    credentials: cfg.credentials as Record<string, string> | undefined,
  }),
);

registerConnector("whatsapp", (cfg) =>
  new (twilioConnector("whatsapp"))({
    accountHandle: String(cfg.accountHandle),
    credentials: cfg.credentials as Record<string, string> | undefined,
  }),
);

export {};
