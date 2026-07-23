import type { RecoverableArtifactStore, StoredArtifact } from '@oracle/artifacts/artifact-store';

import { canonicalBytes, parseJsonBytes } from './canonical-json.js';
import type { OrchestrationPhase, PhaseArtifact } from './types.js';

export async function collectBytes(bytes: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of bytes) {
    chunks.push(Uint8Array.from(chunk));
    byteLength += chunk.byteLength;
    if (!Number.isSafeInteger(byteLength)) throw new RangeError('Artifact exceeds safe byte size');
  }
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function writeJsonArtifact(
  input: Readonly<{
    store: RecoverableArtifactStore;
    runId: string;
    owner: string;
    phase: OrchestrationPhase;
    value: unknown;
  }>,
): Promise<PhaseArtifact> {
  const bytes = canonicalBytes(input.value);
  const sha256 = await crypto.subtle
    .digest('SHA-256', bytes)
    .then((digest) => Buffer.from(digest).toString('hex'));
  const owner = input.owner.replaceAll(/[^a-zA-Z0-9._~-]/gu, '-');
  const logicalKey = `runs/${input.runId.replace('sc:run:', '')}/${owner}/${input.phase}/${sha256}.json`;
  const metadata = Object.freeze({
    runId: input.runId,
    owner: input.owner,
    phase: input.phase,
    canonicalization: 'oracle-canonical-json-v1',
  });
  let stored: StoredArtifact;
  try {
    stored = await input.store.putImmutable({
      logicalKey,
      mediaType: 'application/json',
      body: bytes,
      expectedSha256: sha256,
      metadata,
      ifAbsent: true,
    });
  } catch (error) {
    const orphan = await input.store.headByLogicalKey(logicalKey);
    if (orphan === undefined) throw error;
    stored = orphan;
  }
  if (
    stored.logicalKey !== logicalKey ||
    stored.mediaType !== 'application/json' ||
    stored.byteSize !== bytes.byteLength ||
    stored.sha256 !== sha256 ||
    Object.entries(metadata).some(([key, value]) => stored.metadata[key] !== value)
  ) {
    throw new Error(`Immutable phase artifact orphan mismatch: ${logicalKey}`);
  }
  return phaseArtifact(input.phase, stored);
}

export async function readJsonArtifact(
  store: RecoverableArtifactStore,
  artifact: PhaseArtifact,
): Promise<unknown> {
  const stored = await store.head(artifact.uri);
  if (
    stored?.sha256 !== artifact.sha256 ||
    stored.byteSize !== artifact.byteSize ||
    stored.mediaType !== artifact.mediaType
  ) {
    throw new Error(`Immutable phase artifact failed integrity check: ${artifact.logicalKey}`);
  }
  return parseJsonBytes(await collectBytes(store.read(artifact.uri)));
}

export function phaseArtifact(phase: OrchestrationPhase, stored: StoredArtifact): PhaseArtifact {
  return Object.freeze({
    phase,
    logicalKey: stored.logicalKey,
    uri: stored.uri,
    mediaType: stored.mediaType,
    byteSize: stored.byteSize,
    sha256: stored.sha256,
  });
}
