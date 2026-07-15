import type { Connector, InboundMessage, SendRequest, SendResult } from "@indeedee/shared";
import { registerConnector } from "./registry.js";
import { demoFetch, demoSend, isLiveCredentials } from "./lib/helpers.js";
import { gmailFetch, gmailSend } from "./lib/gmail-api.js";

export class GmailConnector implements Connector {
  readonly channel = "gmail" as const;
  readonly accountHandle: string;
  private credentials: Record<string, string>;

  constructor(config: { accountHandle: string; credentials?: Record<string, string> }) {
    this.accountHandle = config.accountHandle;
    this.credentials = config.credentials ?? {};
  }

  private isLive(): boolean {
    return (
      isLiveCredentials(this.credentials) &&
      Boolean(this.credentials.refreshToken || this.credentials.accessToken)
    );
  }

  async fetch(): Promise<InboundMessage[]> {
    if (!this.isLive()) {
      return demoFetch("gmail", this.accountHandle);
    }
    return gmailFetch(this.accountHandle, this.credentials);
  }

  async send(request: SendRequest): Promise<SendResult> {
    if (!this.isLive()) {
      return demoSend("gmail", this.accountHandle, request);
    }
    return gmailSend(this.accountHandle, this.credentials, request);
  }
}

registerConnector("gmail", (cfg) =>
  new GmailConnector({
    accountHandle: String(cfg.accountHandle),
    credentials: cfg.credentials as Record<string, string> | undefined,
  }),
);
