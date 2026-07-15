import type { InboundMessage, SendRequest, SendResult } from "@indeedee/shared";
import { getGoogleAccessToken } from "./google-oauth.js";
import { parseAddress, parseAddressList } from "./helpers.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const FETCH_LIMIT = 50;

function bodyTextFromPayload(payload: Record<string, unknown>): string {
  const mime = String(payload.mimeType ?? "");
  const body = payload.body as { data?: string } | undefined;
  if (mime === "text/plain" && body?.data) {
    try {
      return Buffer.from(body.data, "base64url").toString("utf8").slice(0, 8000);
    } catch {
      return "";
    }
  }
  const parts = (payload.parts as Record<string, unknown>[] | undefined) ?? [];
  for (const part of parts) {
    const text = bodyTextFromPayload(part);
    if (text) return text;
  }
  return "";
}

function toInbound(
  accountHandle: string,
  msg: Record<string, unknown>,
): InboundMessage {
  const headersList =
    ((msg.payload as Record<string, unknown>)?.headers as { name: string; value: string }[]) ?? [];
  const headers = Object.fromEntries(headersList.map((h) => [h.name.toLowerCase(), h.value]));
  const from = parseAddress(headers.from ?? "");
  const to = parseAddressList(headers.to ?? "");
  const isSelf = from.handle.toLowerCase() === accountHandle.toLowerCase();
  const internalDate = Number(msg.internalDate ?? 0);
  const parts =
    ((msg.payload as Record<string, unknown>)?.parts as Record<string, unknown>[] | undefined) ?? [];

  return {
    channel: "gmail",
    accountHandle,
    externalId: String(msg.id),
    externalThreadId: String(msg.threadId ?? msg.id),
    direction: isSelf ? "outbound" : "inbound",
    sender: isSelf
      ? { handle: accountHandle, displayName: "Executive" }
      : { handle: from.handle, displayName: from.displayName ?? from.handle },
    recipients: isSelf ? to : [{ handle: accountHandle, displayName: "Executive" }],
    subject: headers.subject,
    bodyText: bodyTextFromPayload((msg.payload as Record<string, unknown>) ?? {}) || headers.subject || "",
    sentAt: new Date(internalDate || Date.now()),
    attachments: parts
      .filter((p) => p.filename)
      .map((p, i) => ({
        id: `${msg.id}-${i}`,
        filename: String(p.filename),
        mimeType: p.mimeType ? String(p.mimeType) : undefined,
        sizeBytes: (p.body as { size?: number })?.size,
      })),
    rawRef: `gmail:${accountHandle}:${msg.id}`,
  };
}

export async function gmailFetch(
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<InboundMessage[]> {
  const token = await getGoogleAccessToken(credentials);
  const out: InboundMessage[] = [];
  let pageToken: string | undefined;
  let fetched = 0;

  while (fetched < FETCH_LIMIT) {
    const params = new URLSearchParams({ maxResults: "50" });
    if (pageToken) params.set("pageToken", pageToken);
    const listRes = await fetch(`${GMAIL}/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) throw new Error(`Gmail list failed: ${await listRes.text()}`);
    const listing = (await listRes.json()) as {
      messages?: { id: string }[];
      nextPageToken?: string;
    };

    for (const stub of listing.messages ?? []) {
      try {
        const msgRes = await fetch(`${GMAIL}/messages/${stub.id}?format=full`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!msgRes.ok) continue;
        const msg = (await msgRes.json()) as Record<string, unknown>;
        out.push(toInbound(accountHandle, msg));
        fetched++;
        if (fetched >= FETCH_LIMIT) break;
      } catch {
        // skip bad message
      }
    }

    pageToken = listing.nextPageToken;
    if (!pageToken || fetched >= FETCH_LIMIT) break;
  }

  return out;
}

export async function gmailSend(
  accountHandle: string,
  credentials: Record<string, string>,
  request: SendRequest,
): Promise<SendResult> {
  const token = await getGoogleAccessToken(credentials);
  const to = request.to.map((p) => p.handle).join(", ");
  let subject = (request.subject ?? "").trim();
  if (subject && !subject.toLowerCase().startsWith("re:")) subject = `Re: ${subject}`;
  if (!subject) subject = "Re: (via Indeedee)";

  const lines = [
    `To: ${to}`,
    `From: ${accountHandle}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    request.body,
  ];
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
  const payload: Record<string, string> = { raw };
  if (request.threadExternalId) payload.threadId = request.threadExternalId;

  const res = await fetch(`${GMAIL}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${await res.text()}`);
  const data = (await res.json()) as { id: string; threadId?: string };
  return {
    externalMessageId: data.id,
    providerCorrelationId: data.threadId ?? data.id,
  };
}
