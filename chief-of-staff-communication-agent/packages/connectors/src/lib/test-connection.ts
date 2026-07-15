import type { Channel } from "@indeedee/shared";
import { getGoogleAccessToken } from "./google-oauth.js";
import { guessImapHost } from "./imap-api.js";
import { ImapFlow } from "imapflow";

export interface ConnectionTestResult {
  ok: true;
  label: string;
  mode: "demo" | "live";
}

export async function testChannelConnection(
  channel: Channel,
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<ConnectionTestResult> {
  if (credentials.mode === "demo" || credentials.mode !== "live") {
    return { ok: true, label: `${accountHandle} (demo mode)`, mode: "demo" };
  }

  switch (channel) {
    case "gmail":
      return testGmail(accountHandle, credentials);
    case "email":
      return testImap(accountHandle, credentials);
    case "sms":
    case "whatsapp":
      return testTwilio(channel, accountHandle, credentials);
    case "x":
      return testX(accountHandle, credentials);
    default:
      throw new Error(`Cannot test channel ${channel}`);
  }
}

async function testGmail(
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<ConnectionTestResult> {
  const token = await getGoogleAccessToken(credentials);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail health check failed: ${await res.text()}`);
  const profile = (await res.json()) as { emailAddress?: string };
  return {
    ok: true,
    label: profile.emailAddress ?? accountHandle,
    mode: "live",
  };
}

async function testImap(
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<ConnectionTestResult> {
  const password = credentials.password;
  if (!password) throw new Error("IMAP password missing");

  const imapHost = credentials.imapHost || guessImapHost(accountHandle);
  const client = new ImapFlow({
    host: imapHost,
    port: Number(credentials.imapPort ?? 993),
    secure: true,
    auth: { user: accountHandle, pass: password },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    lock.release();
  } finally {
    await client.logout();
  }

  return { ok: true, label: accountHandle, mode: "live" };
}

async function testTwilio(
  channel: "sms" | "whatsapp",
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<ConnectionTestResult> {
  const { accountSid, authToken } = credentials;
  if (!accountSid || !authToken) throw new Error("Twilio credentials incomplete");

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  if (!res.ok) throw new Error(`Twilio health check failed: ${await res.text()}`);
  const data = (await res.json()) as { friendly_name?: string; status?: string };
  const name = data.friendly_name ?? accountHandle;
  return {
    ok: true,
    label: `${name} · ${channel}${data.status ? ` (${data.status})` : ""}`,
    mode: "live",
  };
}

async function testX(
  accountHandle: string,
  credentials: Record<string, string>,
): Promise<ConnectionTestResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("X access token missing");

  const res = await fetch("https://api.x.com/2/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`X health check failed: ${await res.text()}`);
  const payload = (await res.json()) as { data?: { username?: string; name?: string } };
  const user = payload.data;
  const label = user?.username ? `@${user.username}` : user?.name ?? accountHandle;
  return { ok: true, label, mode: "live" };
}

export async function testAsanaConnection(pat: string): Promise<ConnectionTestResult> {
  if (!pat || pat === "demo") {
    return { ok: true, label: "demo mode", mode: "demo" };
  }
  const res = await fetch("https://app.asana.com/api/1.0/users/me", {
    headers: { Authorization: `Bearer ${pat}` },
  });
  if (!res.ok) throw new Error(`Asana health check failed: ${res.status}`);
  const json = (await res.json()) as { data?: { name?: string; email?: string } };
  const me = json.data;
  return {
    ok: true,
    label: me?.email ?? me?.name ?? "Asana workspace",
    mode: "live",
  };
}
