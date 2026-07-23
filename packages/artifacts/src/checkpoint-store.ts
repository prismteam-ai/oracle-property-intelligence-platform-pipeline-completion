import { createHash } from 'node:crypto';

import { isoDateTimeSchema } from '@oracle/contracts/foundation';

export type CheckpointValue =
  | null
  | boolean
  | number
  | string
  | readonly CheckpointValue[]
  | Readonly<{ [key: string]: CheckpointValue }>;

export type CheckpointEnvelope<TPayload extends CheckpointValue = CheckpointValue> = Readonly<{
  scope: string;
  revision: string;
  previousRevision: string | null;
  payloadSha256: string;
  writtenAt: string;
  payload: TPayload;
}>;

export type CheckpointCommit<TPayload extends CheckpointValue = CheckpointValue> = Readonly<{
  expectedRevision: string | null;
  checkpoint: CheckpointEnvelope<TPayload>;
}>;

export type CheckpointCommitResult<TPayload extends CheckpointValue = CheckpointValue> =
  | Readonly<{ status: 'committed'; checkpoint: CheckpointEnvelope<TPayload> }>
  | Readonly<{ status: 'conflict'; current: CheckpointEnvelope | undefined }>;

export interface CheckpointStore {
  load(scope: string): Promise<CheckpointEnvelope | undefined>;
  commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>>;
}

function canonicalize(value: CheckpointValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Checkpoint numbers must be finite');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const arrayValue = value as readonly CheckpointValue[];
    return `[${arrayValue.map((item) => canonicalize(item)).join(',')}]`;
  }

  const objectValue = value as Readonly<Record<string, CheckpointValue>>;
  return `{${Object.entries(objectValue)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`;
}

export function checkpointPayloadSha256(payload: CheckpointValue): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

export function createCheckpointEnvelope<TPayload extends CheckpointValue>(input: {
  scope: string;
  previousRevision: string | null;
  writtenAt: string;
  payload: TPayload;
}): CheckpointEnvelope<TPayload> {
  if (input.scope.trim().length === 0) {
    throw new TypeError('Checkpoint scope must not be empty');
  }
  const writtenAt = isoDateTimeSchema.parse(input.writtenAt);

  const payloadSha256 = checkpointPayloadSha256(input.payload);
  const revision = createHash('sha256')
    .update(input.scope)
    .update('\0')
    .update(input.previousRevision ?? '')
    .update('\0')
    .update(writtenAt)
    .update('\0')
    .update(payloadSha256)
    .digest('hex');

  return Object.freeze({
    scope: input.scope,
    revision,
    previousRevision: input.previousRevision,
    payloadSha256,
    writtenAt,
    payload: input.payload,
  });
}
