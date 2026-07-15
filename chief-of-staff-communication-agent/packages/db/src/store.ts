import { createClient, type Client } from "@libsql/client";
import {
  deleteConnectorSecretBlob,
  sealConnectorCredentials,
  unsealConnectorCredentials,
} from "./secrets.js";
import type {
  Channel,
  Draft,
  Message,
  Participant,
  PersonSummary,
  RagSourceType,
  Recommendation,
} from "@indeedee/shared";

let client: Client | null = null;

export function resetDb(): void {
  client = null;
}

export function getDb(): Client {
  if (!client) {
    const url = process.env.INDEEDEE_DB_URL ?? "file:data/indeedee.db";
    client = createClient({ url });
  }
  return client;
}

export async function migrate(): Promise<void> {
  const db = getDb();
  await db.batch([
    `CREATE TABLE IF NOT EXISTS connector_tokens (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_handle TEXT NOT NULL,
      credentials_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(owner_id, channel, account_handle)
    )`,
    `CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_handle TEXT NOT NULL,
      external_thread_id TEXT NOT NULL,
      subject TEXT,
      UNIQUE(owner_id, channel, account_handle, external_thread_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_handle TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_thread_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      sender_json TEXT NOT NULL,
      recipients_json TEXT NOT NULL,
      subject TEXT,
      body_text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      raw_ref TEXT,
      answered_status TEXT NOT NULL DEFAULT 'pending',
      answered_at TEXT,
      UNIQUE(owner_id, channel, account_handle, external_id)
    )`,
    `CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL,
      rationale TEXT NOT NULL,
      needs_context INTEGER NOT NULL,
      context_question TEXT,
      topic_key TEXT,
      task_title TEXT,
      task_detail TEXT,
      task_due TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      recommendation_id TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS topic_links (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      topic_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0
    )`,
    `CREATE TABLE IF NOT EXISTS asana_links (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      task_gid TEXT NOT NULL,
      task_url TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS rag_chunks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT,
      text_for_context TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(owner_id, sent_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_drafts_owner_status ON drafts(owner_id, status)`,
  ]);
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function upsertConnectorToken(input: {
  ownerId: string;
  channel: Channel;
  accountHandle: string;
  credentials: Record<string, string>;
}): Promise<void> {
  const db = getDb();
  const sealed = await sealConnectorCredentials(input);
  await db.execute({
    sql: `INSERT INTO connector_tokens (id, owner_id, channel, account_handle, credentials_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_id, channel, account_handle) DO UPDATE SET credentials_json = excluded.credentials_json`,
    args: [
      crypto.randomUUID(),
      input.ownerId,
      input.channel,
      input.accountHandle,
      sealed,
      new Date().toISOString(),
    ],
  });
}

export async function listConnectorTokens(ownerId: string) {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT channel, account_handle, created_at FROM connector_tokens WHERE owner_id = ?`,
    args: [ownerId],
  });
  return res.rows.map((r) => ({
    channel: String(r.channel) as Channel,
    accountHandle: String(r.account_handle),
    connectedAt: String(r.created_at),
  }));
}

export async function deleteConnectorToken(
  ownerId: string,
  channel: Channel,
  accountHandle: string,
): Promise<boolean> {
  const db = getDb();
  const existing = await db.execute({
    sql: `SELECT credentials_json FROM connector_tokens
          WHERE owner_id = ? AND channel = ? AND account_handle = ?`,
    args: [ownerId, channel, accountHandle],
  });
  const blob = existing.rows[0] ? String(existing.rows[0].credentials_json) : null;
  if (blob) await deleteConnectorSecretBlob(blob);

  const res = await db.execute({
    sql: `DELETE FROM connector_tokens WHERE owner_id = ? AND channel = ? AND account_handle = ?`,
    args: [ownerId, channel, accountHandle],
  });
  return (res.rowsAffected ?? 0) > 0;
}

export async function getOwnerAsanaPat(ownerId: string): Promise<string | null> {
  const creds = await getConnectorCredentials(ownerId, "email", "__asana__");
  return creds?.asanaPat ?? null;
}

export async function getConnectorCredentials(
  ownerId: string,
  channel: Channel,
  accountHandle: string,
): Promise<Record<string, string> | null> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT credentials_json FROM connector_tokens
          WHERE owner_id = ? AND channel = ? AND account_handle = ?`,
    args: [ownerId, channel, accountHandle],
  });
  const row = res.rows[0];
  if (!row) return null;
  return unsealConnectorCredentials(String(row.credentials_json));
}

/** Test/diagnostic helper — returns the sealed blob as stored in libSQL. */
export async function getStoredCredentialBlob(
  ownerId: string,
  channel: Channel,
  accountHandle: string,
): Promise<string | null> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT credentials_json FROM connector_tokens
          WHERE owner_id = ? AND channel = ? AND account_handle = ?`,
    args: [ownerId, channel, accountHandle],
  });
  const row = res.rows[0];
  return row ? String(row.credentials_json) : null;
}

export async function upsertMessage(ownerId: string, msg: Omit<Message, "ownerId">): Promise<string> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO threads (id, owner_id, channel, account_handle, external_thread_id, subject)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_id, channel, account_handle, external_thread_id) DO UPDATE SET subject = excluded.subject`,
    args: [msg.threadId, ownerId, msg.channel, msg.accountHandle, msg.externalThreadId, msg.subject ?? null],
  });
  await db.execute({
    sql: `INSERT INTO messages (
      id, owner_id, thread_id, channel, account_handle, external_id, external_thread_id,
      direction, sender_json, recipients_json, subject, body_text, sent_at,
      attachments_json, raw_ref, answered_status, answered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, channel, account_handle, external_id) DO UPDATE SET body_text = excluded.body_text`,
    args: [
      msg.id,
      ownerId,
      msg.threadId,
      msg.channel,
      msg.accountHandle,
      msg.externalId,
      msg.externalThreadId,
      msg.direction,
      JSON.stringify(msg.sender),
      JSON.stringify(msg.recipients),
      msg.subject ?? null,
      msg.bodyText,
      msg.sentAt,
      JSON.stringify(msg.attachments ?? []),
      msg.rawRef ?? null,
      msg.answeredStatus,
      msg.answeredAt ?? null,
    ],
  });
  return msg.id;
}

function rowToMessage(ownerId: string, r: Record<string, unknown>): Message {
  return {
    id: String(r.id),
    ownerId,
    threadId: String(r.thread_id),
    channel: String(r.channel) as Channel,
    accountHandle: String(r.account_handle),
    externalId: String(r.external_id),
    externalThreadId: String(r.external_thread_id),
    direction: String(r.direction) as "inbound" | "outbound",
    sender: parseJson<Participant>(String(r.sender_json), { handle: "unknown" }),
    recipients: parseJson<Participant[]>(String(r.recipients_json), []),
    subject: r.subject ? String(r.subject) : undefined,
    bodyText: String(r.body_text),
    sentAt: String(r.sent_at),
    attachments: parseJson(String(r.attachments_json), []),
    rawRef: r.raw_ref ? String(r.raw_ref) : undefined,
    answeredStatus: String(r.answered_status) as Message["answeredStatus"],
    answeredAt: r.answered_at ? String(r.answered_at) : undefined,
  };
}

export async function listMessages(ownerId: string, filter?: { pendingOnly?: boolean }) {
  const db = getDb();
  const sql = filter?.pendingOnly
    ? `SELECT * FROM messages WHERE owner_id = ? AND direction = 'inbound' AND answered_status = 'pending' ORDER BY sent_at DESC`
    : `SELECT * FROM messages WHERE owner_id = ? ORDER BY sent_at DESC LIMIT 200`;
  const res = await db.execute({ sql, args: [ownerId] });
  return res.rows.map((r) => rowToMessage(ownerId, r as Record<string, unknown>));
}

export async function getMessage(ownerId: string, messageId: string): Promise<Message | null> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM messages WHERE owner_id = ? AND id = ?`,
    args: [ownerId, messageId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return rowToMessage(ownerId, row as Record<string, unknown>);
}

export async function saveRecommendation(ownerId: string, rec: Omit<Recommendation, "ownerId">) {
  const db = getDb();
  await db.execute({
    sql: `INSERT OR REPLACE INTO recommendations (
      id, owner_id, message_id, action, rationale, needs_context, context_question,
      topic_key, task_title, task_detail, task_due, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      rec.id,
      ownerId,
      rec.messageId,
      rec.action,
      rec.rationale,
      rec.needsContext ? 1 : 0,
      rec.contextQuestion ?? null,
      rec.topicKey ?? null,
      rec.taskTitle ?? null,
      rec.taskDetail ?? null,
      rec.taskDue ?? null,
      rec.createdAt,
    ],
  });
}

export async function getRecommendation(ownerId: string, messageId: string): Promise<Recommendation | null> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM recommendations WHERE owner_id = ? AND message_id = ?`,
    args: [ownerId, messageId],
  });
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    ownerId,
    messageId: String(r.message_id),
    action: String(r.action) as Recommendation["action"],
    rationale: String(r.rationale),
    needsContext: Boolean(r.needs_context),
    contextQuestion: r.context_question ? String(r.context_question) : undefined,
    topicKey: r.topic_key ? String(r.topic_key) : undefined,
    taskTitle: r.task_title ? String(r.task_title) : undefined,
    taskDetail: r.task_detail ? String(r.task_detail) : undefined,
    taskDue: r.task_due ? String(r.task_due) : undefined,
    createdAt: String(r.created_at),
  };
}

export async function clearBrainOutputForMessage(ownerId: string, messageId: string) {
  const db = getDb();
  await db.execute({
    sql: `DELETE FROM drafts WHERE owner_id = ? AND message_id = ? AND status = 'pending_approval'`,
    args: [ownerId, messageId],
  });
  await db.execute({
    sql: `DELETE FROM recommendations WHERE owner_id = ? AND message_id = ?`,
    args: [ownerId, messageId],
  });
}

export async function saveDraft(ownerId: string, draft: Omit<Draft, "ownerId">) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO drafts (id, owner_id, message_id, recommendation_id, body, status, created_at, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      draft.id,
      ownerId,
      draft.messageId,
      draft.recommendationId,
      draft.body,
      draft.status,
      draft.createdAt,
      draft.sentAt ?? null,
    ],
  });
}

export async function getDraft(ownerId: string, draftId: string): Promise<Draft | null> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM drafts WHERE owner_id = ? AND id = ?`,
    args: [ownerId, draftId],
  });
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    ownerId,
    messageId: String(r.message_id),
    recommendationId: String(r.recommendation_id),
    body: String(r.body),
    status: String(r.status) as Draft["status"],
    createdAt: String(r.created_at),
    sentAt: r.sent_at ? String(r.sent_at) : undefined,
  };
}

export async function updateDraftStatus(ownerId: string, draftId: string, status: Draft["status"]) {
  const db = getDb();
  const sentAt = status === "sent" ? new Date().toISOString() : null;
  await db.execute({
    sql: `UPDATE drafts SET status = ?, sent_at = COALESCE(?, sent_at) WHERE owner_id = ? AND id = ?`,
    args: [status, sentAt, ownerId, draftId],
  });
}

export async function listPendingDrafts(ownerId: string): Promise<Draft[]> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM drafts WHERE owner_id = ? AND status = 'pending_approval' ORDER BY created_at DESC`,
    args: [ownerId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    ownerId,
    messageId: String(r.message_id),
    recommendationId: String(r.recommendation_id),
    body: String(r.body),
    status: String(r.status) as Draft["status"],
    createdAt: String(r.created_at),
    sentAt: r.sent_at ? String(r.sent_at) : undefined,
  }));
}

export async function markMessageAnswered(ownerId: string, messageId: string) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE messages SET answered_status = 'answered', answered_at = ? WHERE owner_id = ? AND id = ?`,
    args: [new Date().toISOString(), ownerId, messageId],
  });
}

export async function upsertTopicLink(ownerId: string, topicKey: string, messageId: string) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO topic_links (id, owner_id, topic_key, message_id, confidence) VALUES (?, ?, ?, ?, 1.0)`,
    args: [crypto.randomUUID(), ownerId, topicKey, messageId],
  });
}

export async function listTopicMessages(ownerId: string, topicKey: string) {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT m.* FROM topic_links t JOIN messages m ON m.id = t.message_id
          WHERE t.owner_id = ? AND t.topic_key = ? ORDER BY m.sent_at DESC`,
    args: [ownerId, topicKey],
  });
  return res.rows.map((r) => rowToMessage(ownerId, r as Record<string, unknown>));
}

export async function listPeople(ownerId: string): Promise<PersonSummary[]> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT sender_json, channel, sent_at FROM messages
          WHERE owner_id = ? AND direction = 'inbound' ORDER BY sent_at DESC`,
    args: [ownerId],
  });
  const byHandle = new Map<
    string,
    PersonSummary & { channelSet: Set<string> }
  >();
  for (const r of res.rows) {
    const sender = parseJson(String(r.sender_json), { handle: "unknown" }) as {
      handle: string;
      displayName?: string;
    };
    const handle = sender.handle;
    let row = byHandle.get(handle);
    if (!row) {
      row = {
        handle,
        displayName: sender.displayName,
        messageCount: 0,
        lastMessageAt: String(r.sent_at),
        channels: [],
        channelSet: new Set(),
      };
      byHandle.set(handle, row);
    }
    row.messageCount += 1;
    row.channelSet.add(String(r.channel));
    if (String(r.sent_at) > row.lastMessageAt) row.lastMessageAt = String(r.sent_at);
  }
  return [...byHandle.values()]
    .map(({ channelSet, ...person }) => ({
      ...person,
      channels: [...channelSet] as Channel[],
    }))
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
}

export async function listMessagesBySender(ownerId: string, senderHandle: string) {
  const messages = await listMessages(ownerId);
  return messages
    .filter((m) => m.direction === "inbound" && m.sender.handle === senderHandle)
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

export async function saveAsanaLink(ownerId: string, messageId: string, taskGid: string, taskUrl: string) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO asana_links (id, owner_id, message_id, task_gid, task_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), ownerId, messageId, taskGid, taskUrl, new Date().toISOString()],
  });
}

export async function listAsanaLinks(ownerId: string, messageId: string) {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT task_gid, task_url, created_at FROM asana_links WHERE owner_id = ? AND message_id = ?`,
    args: [ownerId, messageId],
  });
  return res.rows.map((r) => ({
    taskGid: String(r.task_gid),
    taskUrl: String(r.task_url),
    createdAt: String(r.created_at),
  }));
}

export async function addKnowledge(ownerId: string, kind: "preference" | "org", title: string, body: string) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO knowledge (id, owner_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, ownerId, kind, title, body, now],
  });
  await indexRagChunk(ownerId, kind === "preference" ? "preference" : "org_knowledge", id, title, body);
  return id;
}

export async function listKnowledge(ownerId: string) {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT id, kind, title, body, created_at FROM knowledge WHERE owner_id = ? ORDER BY created_at DESC`,
    args: [ownerId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind) as "preference" | "org",
    title: r.title ? String(r.title) : undefined,
    body: String(r.body),
    createdAt: String(r.created_at),
  }));
}

export async function indexRagChunk(
  ownerId: string,
  sourceType: RagSourceType,
  sourceId: string,
  title: string | undefined,
  text: string,
) {
  const db = getDb();
  await db.execute({
    sql: `INSERT OR REPLACE INTO rag_chunks (id, owner_id, source_type, source_id, title, text_for_context, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, '{}')`,
    args: [`${sourceType}:${sourceId}`, ownerId, sourceType, sourceId, title ?? null, text],
  });
}

export async function searchRag(ownerId: string, query: string, topK = 5) {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM rag_chunks WHERE owner_id = ?`,
    args: [ownerId],
  });
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return res.rows
    .map((r) => {
      const text = String(r.text_for_context).toLowerCase();
      let hits = 0;
      for (const t of terms) if (text.includes(t)) hits++;
      return {
        id: String(r.id),
        sourceType: String(r.source_type),
        sourceId: String(r.source_id),
        title: r.title ? String(r.title) : undefined,
        text: String(r.text_for_context),
        score: terms.length ? hits / terms.length : 0,
      };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export async function getStyleCorpus(ownerId: string, limit = 8): Promise<string[]> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT body_text FROM messages WHERE owner_id = ? AND direction = 'outbound' ORDER BY sent_at DESC LIMIT ?`,
    args: [ownerId, limit],
  });
  return res.rows.map((r) => String(r.body_text)).filter(Boolean);
}

export async function dashboardMetrics(ownerId: string) {
  const db = getDb();
  const inbound = await db.execute({
    sql: `SELECT channel, answered_status, sent_at FROM messages WHERE owner_id = ? AND direction = 'inbound'`,
    args: [ownerId],
  });
  const pendingDrafts = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM drafts WHERE owner_id = ? AND status = 'pending_approval'`,
    args: [ownerId],
  });
  const now = Date.now();
  const slaMs = 5 * 60 * 1000;
  let answered = 0;
  let pending = 0;
  let overdue = 0;
  const byChannel: Record<string, number> = {};
  for (const r of inbound.rows) {
    const ch = String(r.channel);
    byChannel[ch] = (byChannel[ch] ?? 0) + 1;
    const status = String(r.answered_status);
    if (status === "answered") answered++;
    else if (status === "pending") {
      pending++;
      if (now - new Date(String(r.sent_at)).getTime() > slaMs) overdue++;
    }
  }
  return {
    totalInbound: inbound.rows.length,
    answered,
    pending,
    overdue,
    pendingApprovals: Number(pendingDrafts.rows[0]?.c ?? 0),
    byChannel,
  };
}
