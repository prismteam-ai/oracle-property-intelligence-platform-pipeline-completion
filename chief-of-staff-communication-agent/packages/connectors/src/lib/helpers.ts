import type { InboundMessage } from "@indeedee/shared";
import { DemoConnector } from "../demo.js";

export function isLiveCredentials(credentials: Record<string, string>): boolean {
  return credentials.mode === "live";
}

export async function demoFetch(
  channel: DemoConnector["channel"],
  accountHandle: string,
): Promise<InboundMessage[]> {
  return new DemoConnector({ channel, accountHandle }).fetch();
}

export async function demoSend(
  channel: DemoConnector["channel"],
  accountHandle: string,
  request: Parameters<DemoConnector["send"]>[0],
) {
  return new DemoConnector({ channel, accountHandle }).send(request);
}

/** Parse "Name <email@x.com>" or bare email/handle. */
export function parseAddress(raw: string): { handle: string; displayName?: string } {
  const m = raw.match(/^(?:"?([^"]*)"?\s)?<?([^>]+@[^>]+)>?$/);
  if (m?.[2]) return { displayName: m[1]?.trim() || undefined, handle: m[2].trim() };
  return { handle: raw.trim() };
}

export function parseAddressList(raw: string): Array<{ handle: string; displayName?: string }> {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseAddress);
}
