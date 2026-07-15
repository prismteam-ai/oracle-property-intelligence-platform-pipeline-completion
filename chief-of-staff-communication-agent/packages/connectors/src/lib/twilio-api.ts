import type { InboundMessage, SendRequest, SendResult } from "@indeedee/shared";

const FETCH_LIMIT = 50;

function cleanNumber(num: string): string {
  return (num ?? "").replace(/^whatsapp:/, "");
}

function parseTwilioDate(raw: string | undefined): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export async function twilioFetch(
  channel: "sms" | "whatsapp",
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<InboundMessage[]> {
  const { accountSid, authToken, fromNumber } = credentials;
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("Twilio accountSid, authToken, and fromNumber required");
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json?PageSize=${FETCH_LIMIT}`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Twilio list failed: ${await res.text()}`);

  const data = (await res.json()) as { messages?: Record<string, string>[] };
  const isWa = channel === "whatsapp";
  const out: InboundMessage[] = [];

  for (const m of data.messages ?? []) {
    const from = m.from ?? "";
    const to = m.to ?? "";
    if (isWa !== (from.includes("whatsapp:") || to.includes("whatsapp:"))) continue;

    const inbound = m.direction === "inbound";
    const frm = cleanNumber(from);
    const toNum = cleanNumber(to);
    const counterpart = inbound ? frm : toNum;

    out.push({
      channel,
      accountHandle,
      externalId: m.sid ?? `twilio-${Date.now()}`,
      externalThreadId: counterpart,
      direction: inbound ? "inbound" : "outbound",
      sender: { handle: frm, displayName: frm },
      recipients: [{ handle: toNum }],
      bodyText: m.body ?? "",
      sentAt: parseTwilioDate(m.date_sent || m.date_created),
      rawRef: `twilio:${channel}:${m.sid}`,
    });
  }

  return out;
}

export async function twilioSend(
  channel: "sms" | "whatsapp",
  credentials: Record<string, string>,
  request: SendRequest,
): Promise<SendResult> {
  const { accountSid, authToken, fromNumber } = credentials;
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("Twilio accountSid, authToken, and fromNumber required");
  }

  const isWa = channel === "whatsapp";
  const toRaw = cleanNumber(request.to[0]?.handle ?? "");
  const toAddr = isWa ? `whatsapp:${toRaw}` : toRaw;
  const fromAddr = isWa ? `whatsapp:${cleanNumber(fromNumber)}` : fromNumber;

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const body = new URLSearchParams({ From: fromAddr, To: toAddr, Body: request.body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
  if (!res.ok) throw new Error(`Twilio send failed: ${await res.text()}`);
  const data = (await res.json()) as { sid: string };
  return { externalMessageId: data.sid, providerCorrelationId: data.sid };
}
