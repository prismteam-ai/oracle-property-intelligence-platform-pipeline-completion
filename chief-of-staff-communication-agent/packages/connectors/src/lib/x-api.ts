import type { InboundMessage, SendRequest, SendResult } from "@indeedee/shared";

const X_API = "https://api.x.com/2";

export async function xFetch(
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<InboundMessage[]> {
  const token = credentials.accessToken;
  const selfUserId = credentials.selfUserId ?? "";
  if (!token) throw new Error("X access token required");

  const params = new URLSearchParams({
    event_types: "MessageCreate",
    "dm_event.fields": "id,text,created_at,sender_id,dm_conversation_id",
    expansions: "sender_id",
    "user.fields": "username,name",
    max_results: "50",
  });

  const res = await fetch(`${X_API}/dm_events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`X dm_events failed: ${await res.text()}`);

  const payload = (await res.json()) as {
    data?: Record<string, string>[];
    includes?: { users?: { id: string; username?: string; name?: string }[] };
  };
  const users = Object.fromEntries(
    (payload.includes?.users ?? []).map((u) => [u.id, u]),
  ) as Record<string, { id: string; username?: string; name?: string }>;
  const out: InboundMessage[] = [];

  for (const ev of payload.data ?? []) {
    const sender = users[ev.sender_id ?? ""] ?? { id: ev.sender_id ?? "unknown" };
    const isSelf = ev.sender_id === selfUserId;
    const handle = sender.username ? `@${sender.username}` : (ev.sender_id ?? "unknown");
    const who = { handle, displayName: sender.name ?? handle };

    out.push({
      channel: "x",
      accountHandle,
      externalId: ev.id ?? `x-${Date.now()}`,
      externalThreadId: ev.dm_conversation_id ?? ev.id ?? "x-thread",
      direction: isSelf ? "outbound" : "inbound",
      sender: isSelf ? { handle: accountHandle, displayName: "Executive" } : who,
      recipients: isSelf ? [who] : [{ handle: accountHandle, displayName: "Executive" }],
      bodyText: ev.text ?? "",
      sentAt: new Date(ev.created_at ?? Date.now()),
      rawRef: `x:dm_events:${ev.id}`,
    });
  }

  return out;
}

export async function xSend(
  accountHandle: string,
  credentials: Record<string, string>,
  request: SendRequest,
): Promise<SendResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("X access token required");

  let participant = request.to[0]?.handle ?? request.threadExternalId ?? "";
  participant = participant.replace(/^@/, "");

  const res = await fetch(`${X_API}/dm_conversations/with/${participant}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: request.body }),
  });
  if (!res.ok) throw new Error(`X DM send failed: ${await res.text()}`);
  const data = (await res.json()) as { data?: { dm_event_id?: string } };
  const id = data.data?.dm_event_id ?? "x-sent";
  return { externalMessageId: id, providerCorrelationId: id };
}
