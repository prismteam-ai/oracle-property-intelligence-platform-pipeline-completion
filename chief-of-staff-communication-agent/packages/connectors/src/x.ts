import type { Connector, InboundMessage, SendRequest, SendResult } from "@indeedee/shared";
import { registerConnector } from "./registry.js";
import { demoFetch, demoSend, isLiveCredentials } from "./lib/helpers.js";
import { xFetch, xSend } from "./lib/x-api.js";

export class XConnector implements Connector {
  readonly channel = "x" as const;
  readonly accountHandle: string;
  private credentials: Record<string, string>;

  constructor(config: { accountHandle: string; credentials?: Record<string, string> }) {
    this.accountHandle = config.accountHandle;
    this.credentials = config.credentials ?? {};
  }

  private isLive(): boolean {
    return isLiveCredentials(this.credentials) && Boolean(this.credentials.accessToken);
  }

  async fetch(): Promise<InboundMessage[]> {
    if (!this.isLive()) {
      return demoFetch("x", this.accountHandle);
    }
    return xFetch(this.accountHandle, this.credentials);
  }

  async send(request: SendRequest): Promise<SendResult> {
    if (!this.isLive()) {
      return demoSend("x", this.accountHandle, request);
    }
    return xSend(this.accountHandle, this.credentials, request);
  }
}

registerConnector("x", (cfg) =>
  new XConnector({
    accountHandle: String(cfg.accountHandle),
    credentials: cfg.credentials as Record<string, string> | undefined,
  }),
);
