import type { InboundMessage, SendRequest, SendResult } from "@indeedee/shared";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const FETCH_LIMIT = 50;

export function guessImapHost(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    "gmail.com": "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "zoho.com": "imap.zoho.com",
    "fastmail.com": "imap.fastmail.com",
    "yahoo.com": "imap.mail.yahoo.com",
    "icloud.com": "imap.mail.me.com",
    "me.com": "imap.mail.me.com",
    "outlook.com": "outlook.office365.com",
    "hotmail.com": "outlook.office365.com",
    "office365.com": "outlook.office365.com",
  };
  return map[domain] ?? `imap.${domain}`;
}

function guessSmtpHost(imapHost: string): string {
  if (imapHost.includes("office365") || imapHost.includes("outlook")) return "smtp.office365.com";
  if (imapHost.includes("mail.me.com")) return "smtp.mail.me.com";
  return imapHost.replace(/^imap\./, "smtp.");
}

export async function imapFetch(
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<InboundMessage[]> {
  const password = credentials.password;
  if (!password) throw new Error("IMAP password required");

  const imapHost = credentials.imapHost || guessImapHost(accountHandle);
  const client = new ImapFlow({
    host: imapHost,
    port: Number(credentials.imapPort ?? 993),
    secure: true,
    auth: { user: accountHandle, pass: password },
    logger: false,
  });

  const out: InboundMessage[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ all: true });
      const idList = Array.isArray(uids) ? uids : [];
      const recent = idList.slice(-FETCH_LIMIT);
      for await (const msg of client.fetch(recent, { source: true, uid: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value[0];
        const senderHandle = from?.address ?? "unknown";
        const isSelf = senderHandle.toLowerCase() === accountHandle.toLowerCase();
        const refs = String(parsed.references ?? parsed.inReplyTo ?? parsed.messageId ?? `imap-${msg.uid}`);

        out.push({
          channel: "email",
          accountHandle,
          externalId: parsed.messageId ?? `imap-${msg.uid}`,
          externalThreadId: refs.split(/\s+/)[0] ?? String(msg.uid),
          direction: isSelf ? "outbound" : "inbound",
          sender: {
            handle: senderHandle,
            displayName: from?.name ?? senderHandle,
          },
          recipients: (parsed.to?.value ?? []).map((t: { address?: string; name?: string }) => ({
            handle: t.address ?? "",
            displayName: t.name,
          })),
          subject: parsed.subject,
          bodyText: parsed.text ?? parsed.subject ?? "",
          sentAt: parsed.date ?? new Date(),
          rawRef: `imap:${accountHandle}:${msg.uid}`,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return out;
}

export async function imapSend(
  accountHandle: string,
  credentials: Record<string, string>,
  request: SendRequest,
): Promise<SendResult> {
  const password = credentials.password;
  if (!password) throw new Error("IMAP password required");

  const imapHost = credentials.imapHost || guessImapHost(accountHandle);
  const smtpHost = credentials.smtpHost || guessSmtpHost(imapHost);
  const smtpPort = Number(credentials.smtpPort ?? (smtpHost.includes("office365") ? 587 : 465));
  const secure = smtpPort === 465;

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure,
    auth: { user: accountHandle, pass: password },
  });

  let subject = (request.subject ?? "").trim();
  if (subject && !subject.toLowerCase().startsWith("re:")) subject = `Re: ${subject}`;

  const info = await transporter.sendMail({
    from: accountHandle,
    to: request.to.map((p) => p.handle).join(", "),
    subject: subject || "Re: (via Indeedee)",
    text: request.body,
    inReplyTo: request.threadExternalId,
  });

  return {
    externalMessageId: info.messageId ?? `smtp-${Date.now()}`,
    providerCorrelationId: info.messageId ?? request.threadExternalId ?? "",
  };
}
