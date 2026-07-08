/**
 * Minimal A2A (Agent2Agent protocol) JSON-RPC client for the Oracle agent.
 *
 * Empirically the endpoint answers `message/send` with a completed *task*
 * object: `result.kind === 'task'`, the answer text living in
 * `result.artifacts[].parts[]` as `{kind:'text', text}` parts, with
 * `result.status.state` ('completed' | 'failed' | ...) and a `contextId`
 * that can be echoed back to continue the same conversation. We still parse
 * defensively — direct `message` results and `status.message` fallbacks are
 * handled, and on total parse failure the raw JSON is surfaced to the UI.
 */

import { AGENT_A2A_URL } from '../config';

export interface AskResult {
  /** Markdown answer text, or null if no text part could be found. */
  text: string | null;
  /** Full JSON-RPC response, for the raw-JSON fallback view. */
  raw: unknown;
  /** A2A context id to send with the next turn (conversation memory). */
  contextId: string | null;
}

/** Agent turns run live SQL over IPFS and take 20s–3min; allow up to 6min. */
const TIMEOUT_MS = 360_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Collect text from an A2A parts array ({kind|type:'text', text:...}). */
function textFromParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const p of parts) {
    if (!isRecord(p)) continue;
    const kind = p.kind ?? p.type;
    if ((kind === 'text' || kind === undefined) && typeof p.text === 'string') {
      out.push(p.text);
    }
  }
  return out;
}

/** Pull answer text out of whatever result shape came back. */
function extractText(result: Record<string, unknown>): string | null {
  // 1) Task artifacts — the shape observed from the live endpoint.
  if (Array.isArray(result.artifacts)) {
    const texts: string[] = [];
    for (const a of result.artifacts) {
      if (isRecord(a)) texts.push(...textFromParts(a.parts));
    }
    if (texts.length) return texts.join('\n\n');
  }
  // 2) status.message (some servers put the final message here).
  if (isRecord(result.status) && isRecord(result.status.message)) {
    const texts = textFromParts(result.status.message.parts);
    if (texts.length) return texts.join('\n\n');
  }
  // 3) A direct message result (kind === 'message').
  if (result.kind === 'message') {
    const texts = textFromParts(result.parts);
    if (texts.length) return texts.join('\n\n');
  }
  // 4) Last agent-authored text message in history.
  if (Array.isArray(result.history)) {
    for (let i = result.history.length - 1; i >= 0; i--) {
      const m = result.history[i];
      if (isRecord(m) && m.role === 'agent') {
        const texts = textFromParts(m.parts);
        if (texts.length) return texts.join('\n\n');
      }
    }
  }
  return null;
}

function makeUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function askOracle(
  question: string,
  contextId: string | null,
): Promise<AskResult> {
  const message: Record<string, unknown> = {
    role: 'user',
    parts: [{ kind: 'text', text: question }],
    messageId: makeUuid(),
  };
  if (contextId) message.contextId = contextId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(AGENT_A2A_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: makeUuid(),
        method: 'message/send',
        params: { message },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `No response after ${TIMEOUT_MS / 60000} minutes — the agent may be stuck or the server down.`,
      );
    }
    throw new Error(
      `Could not reach the agent at ${AGENT_A2A_URL} — is the A2A server running? (${err instanceof Error ? err.message : String(err)})`,
    );
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Agent returned HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error(`Agent returned non-JSON: ${bodyText.slice(0, 500)}`);
  }
  if (!isRecord(json)) throw new Error('Agent returned unexpected non-object JSON.');

  // JSON-RPC level error.
  if (isRecord(json.error)) {
    const msg =
      typeof json.error.message === 'string'
        ? json.error.message
        : JSON.stringify(json.error);
    throw new Error(`A2A error ${String(json.error.code ?? '')}: ${msg}`.trim());
  }

  const result = json.result;
  if (!isRecord(result)) {
    return { text: null, raw: json, contextId: null };
  }

  const text = extractText(result);
  const newContextId =
    typeof result.contextId === 'string' ? result.contextId : null;

  // Terminal failure states: surface as an error (with any text we found).
  const state = isRecord(result.status) ? result.status.state : undefined;
  if (state === 'failed' || state === 'rejected' || state === 'canceled') {
    throw new Error(
      `Agent task ${String(state)}${text ? `: ${text}` : ' (no error text returned).'}`,
    );
  }

  return { text, raw: json, contextId: newContextId };
}
