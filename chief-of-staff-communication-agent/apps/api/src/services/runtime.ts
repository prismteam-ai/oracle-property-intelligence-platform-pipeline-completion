import type { InboundMessage, Message } from "@indeedee/shared";
import { connectorFor, connectorsForOwner } from "@indeedee/connectors";
import { indexRagChunk, upsertMessage } from "@indeedee/db";

export async function ingestForOwner(ownerId: string) {
  const connectors = await connectorsForOwner(ownerId);
  let ingested = 0;
  for (const conn of connectors) {
    const batch = await conn.fetch();
    for (const raw of batch) {
      await persistInbound(ownerId, raw);
      ingested++;
    }
  }
  return { ingested, connectors: connectors.length };
}

async function persistInbound(ownerId: string, raw: InboundMessage) {
  const threadId = `${raw.channel}:${raw.accountHandle}:${raw.externalThreadId}`;
  const msg: Omit<Message, "ownerId"> = {
    id: crypto.randomUUID(),
    threadId,
    channel: raw.channel,
    accountHandle: raw.accountHandle,
    externalId: raw.externalId,
    externalThreadId: raw.externalThreadId,
    direction: raw.direction,
    sender: raw.sender,
    recipients: raw.recipients,
    subject: raw.subject,
    bodyText: raw.bodyText,
    sentAt: raw.sentAt.toISOString(),
    attachments: raw.attachments ?? [],
    rawRef: raw.rawRef,
    answeredStatus: raw.direction === "inbound" ? "pending" : "no_reply_needed",
  };
  const id = await upsertMessage(ownerId, msg);
  await indexRagChunk(ownerId, "message", id, raw.subject, raw.bodyText);
}

export async function sendApprovedDraft(ownerId: string, draftId: string, editedBody?: string) {
  const {
    getDraft,
    getMessage,
    getRecommendation,
    updateDraftStatus,
    markMessageAnswered,
    upsertMessage,
    saveAsanaLink,
  } = await import("@indeedee/db");
  const { assertSendAllowed } = await import("@indeedee/shared");
  const { createTaskFromMessage } = await import("@indeedee/asana");

  const draft = await getDraft(ownerId, draftId);
  if (!draft) throw new Error("Draft not found");
  if (draft.status !== "pending_approval") {
    throw new Error(`Cannot send draft in status ${draft.status}`);
  }

  await updateDraftStatus(ownerId, draftId, "approved");
  assertSendAllowed("approved");

  const message = await getMessage(ownerId, draft.messageId);
  if (!message) throw new Error("Message not found");

  const body = editedBody ?? draft.body;
  const conn = await connectorFor(ownerId, message.channel, message.accountHandle);
  if (!conn) throw new Error(`No connector for ${message.channel}`);

  const result = await conn.send({
    to: [message.sender],
    body,
    threadExternalId: message.externalThreadId,
    subject: message.subject,
  });

  await updateDraftStatus(ownerId, draftId, "sent");
  await markMessageAnswered(ownerId, message.id);

  await upsertMessage(ownerId, {
    ...message,
    id: crypto.randomUUID(),
    direction: "outbound",
    externalId: result.externalMessageId,
    bodyText: body,
    sentAt: new Date().toISOString(),
    answeredStatus: "no_reply_needed",
    sender: { handle: message.accountHandle, displayName: "Executive" },
    recipients: [message.sender],
    rawRef: result.providerCorrelationId,
  });

  const rec = await getRecommendation(ownerId, message.id);
  if (rec?.action === "create_task" && rec.taskTitle) {
    const { getOwnerAsanaPat } = await import("@indeedee/db");
    const pat = process.env.ASANA_PAT ?? (await getOwnerAsanaPat(ownerId)) ?? "demo";
    const task = await createTaskFromMessage({
      pat,
      title: rec.taskTitle,
      notes: rec.taskDetail ?? message.bodyText,
      dueOn: rec.taskDue,
    });
    await saveAsanaLink(ownerId, message.id, task.gid, task.url);
  }

  return { draftId, externalMessageId: result.externalMessageId };
}

export async function runSync(ownerId: string) {
  const ingest = await ingestForOwner(ownerId);
  const { processPending } = await import("@indeedee/brain");
  const brain = await processPending(ownerId);
  return { ingest, brainProcessed: brain.length };
}

export async function seedDemoConnections(ownerId: string) {
  const { upsertConnectorToken } = await import("@indeedee/db");
  const channels = [
    { channel: "gmail" as const, accountHandle: "exec@company.com" },
    { channel: "email" as const, accountHandle: "exec@zoho.com" },
    { channel: "sms" as const, accountHandle: "+15550001111" },
    { channel: "whatsapp" as const, accountHandle: "whatsapp:+15550001111" },
    { channel: "x" as const, accountHandle: "@exec_handle" },
  ];
  for (const c of channels) {
    await upsertConnectorToken({
      ownerId,
      channel: c.channel,
      accountHandle: c.accountHandle,
      credentials: { mode: "demo" },
    });
  }
  return channels;
}
