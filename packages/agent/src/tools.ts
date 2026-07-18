import { jsonSchema, tool, type Schema, type Tool, zodSchema } from 'ai';
import type { ZodType } from 'zod';

import {
  NAMED_EVIDENCE_TOOL_NAMES,
  namedEvidenceEnvelopeSchema,
  namedEvidenceInputSchemas,
  type EvidenceSupportState,
  type NamedEvidenceEnvelope,
  type NamedEvidenceExecutor,
  type NamedEvidenceToolName,
} from './contracts.js';

export interface InvocationLedger {
  releaseId: string;
  calls: number;
  failures: number;
  evidenceIds: Set<string>;
  supportStates: Set<EvidenceSupportState>;
  trace: NamedToolTraceRecord[];
}

export type NamedToolTraceRecord = Readonly<{
  callIndex: number;
  toolName: NamedEvidenceToolName;
  releaseId: string;
  evidenceIds: readonly string[];
}>;

export type NamedEvidenceTools = Record<
  NamedEvidenceToolName,
  Tool<unknown, NamedEvidenceEnvelope>
>;

type ModelJsonSchema = Awaited<Schema['jsonSchema']>;

const BEDROCK_UNSUPPORTED_NUMERIC_SCHEMA_KEYWORDS = new Set([
  'exclusiveMaximum',
  'exclusiveMinimum',
  'maximum',
  'minimum',
]);

function removeUnsupportedNumericBounds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUnsupportedNumericBounds);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      BEDROCK_UNSUPPORTED_NUMERIC_SCHEMA_KEYWORDS.has(key)
        ? []
        : [[key, removeUnsupportedNumericBounds(child)]],
    ),
  );
}

function bedrockCompatibleInputSchema(schema: ZodType): Schema {
  const authoritativeSchema = zodSchema(schema);
  return jsonSchema(
    async () =>
      removeUnsupportedNumericBounds(await authoritativeSchema.jsonSchema) as ModelJsonSchema,
    {
      validate: async (value) => {
        const result = await schema.safeParseAsync(value);
        return result.success
          ? { success: true, value: result.data }
          : { success: false, error: result.error };
      },
    },
  );
}

function invocationLedger(value: unknown): InvocationLedger {
  if (typeof value !== 'object' || value === null || !('ledger' in value)) {
    throw new TypeError('Named evidence tool invocation context is missing');
  }
  const ledger = value.ledger;
  if (
    typeof ledger !== 'object' ||
    ledger === null ||
    !('evidenceIds' in ledger) ||
    !(ledger.evidenceIds instanceof Set)
  ) {
    throw new TypeError('Named evidence tool invocation ledger is invalid');
  }
  return ledger as InvocationLedger;
}

const prohibitedPayloadKey =
  /(?:sql|statement|relationpath|tablepath|path|uri|url|host|objectkey|raw|secret|ownername|owneraddress|mailingaddress)$/iu;
const prohibitedPayloadValue = /(?:file:\/\/|s3:\/\/|https?:\/\/|[a-z]:\\)/iu;

function assertSafePayload(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafePayload(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'string' && prohibitedPayloadValue.test(value)) {
    throw new TypeError(`Evidence payload contains a prohibited physical locator at ${path}`);
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (prohibitedPayloadKey.test(key)) {
      throw new TypeError(
        `Evidence payload contains prohibited authority or restricted data at ${path}.${key}`,
      );
    }
    assertSafePayload(child, `${path}.${key}`);
  }
}

export function createNamedEvidenceTools(executor: NamedEvidenceExecutor): NamedEvidenceTools {
  return Object.fromEntries(
    NAMED_EVIDENCE_TOOL_NAMES.map((name) => {
      const inputSchema = namedEvidenceInputSchemas[name];
      const result = tool({
        description: `Read immutable Oracle evidence using ${name}. This tool is read-only and release-bound.`,
        inputSchema: bedrockCompatibleInputSchema(inputSchema),
        strict: true,
        execute: async (input, options) => {
          const ledger = invocationLedger(options.experimental_context);
          ledger.calls += 1;
          if (ledger.calls > 6) {
            ledger.failures += 1;
            throw new RangeError('Named evidence tool-call budget exceeded');
          }
          const parsedInput = inputSchema.parse(input);
          if (parsedInput.releaseId !== undefined && parsedInput.releaseId !== ledger.releaseId) {
            throw new TypeError('Tool release does not match the immutable agent release');
          }
          let raw: unknown;
          try {
            raw = await executor.execute(name, parsedInput, {
              ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
            });
            assertSafePayload(raw);
          } catch (error) {
            ledger.failures += 1;
            throw error;
          }
          const envelope = namedEvidenceEnvelopeSchema.parse(raw);
          if (envelope.releaseId !== ledger.releaseId) {
            throw new TypeError('Evidence executor returned a different release');
          }
          for (const item of envelope.evidence) {
            ledger.evidenceIds.add(item.evidenceId);
            ledger.supportStates.add(item.supportState);
          }
          ledger.trace.push(
            Object.freeze({
              callIndex: ledger.calls,
              toolName: name,
              releaseId: ledger.releaseId,
              evidenceIds: Object.freeze(
                envelope.evidence.map(({ evidenceId }) => evidenceId).sort(),
              ),
            }),
          );
          return envelope;
        },
      });
      return [name, result] as const;
    }),
  ) as NamedEvidenceTools;
}
