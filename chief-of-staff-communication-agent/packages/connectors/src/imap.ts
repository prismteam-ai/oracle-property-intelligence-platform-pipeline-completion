import type { Connector, InboundMessage, SendRequest, SendResult } from "@indeedee/shared";
import { registerConnector } from "./registry.js";
import { demoFetch, demoSend, isLiveCredentials } from "./lib/helpers.js";
import { imapFetch, imapSend } from "./lib/imap-api.js";

/** IMAP/SMTP email — additional provider beyond Gmail (AC-04). */
export class ImapEmailConnector implements Connector {
  readonly channel = "email" as const;
  readonly accountHandle: string;
  private credentials: Record<string, string>;

  constructor(config: { accountHandle: string; credentials?: Record<string, string> }) {
    this.accountHandle = config.accountHandle;
    this.credentials = config.credentials ?? {};
  }

  private isLive(): boolean {
    return isLiveCredentials(this.credentials) && Boolean(this.credentials.password);
  }

  async fetch(): Promise<InboundMessage[]> {
    if (!this.isLive()) {
      return demoFetch("email", this.accountHandle);
    }
    return imapFetch(this.accountHandle, this.credentials);
  }

  async send(request: SendRequest): Promise<SendResult> {
    if (!this.isLive()) {
      return demoSend("email", this.accountHandle, request);
    }
    return imapSend(this.accountHandle, this.credentials, request);
  }
}

registerConnector("email", (cfg) =>
  new ImapEmailConnector({
    accountHandle: String(cfg.accountHandle),
    credentials: cfg.credentials as Record<string, string> | undefined,
  }),
);
