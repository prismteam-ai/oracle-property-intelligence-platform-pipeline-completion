import type { OracleModelGateway } from '@oracle/model-gateway';
import { ToolLoopAgent, stepCountIs } from 'ai';
import { z } from 'zod';

import { ORACLE_AGENT_PROMPT_POLICY, type SemanticPolicy } from './policy.js';
import {
  createNamedEvidenceTools,
  type InvocationLedger,
  type NamedEvidenceTools,
  type NamedToolTraceRecord,
} from './tools.js';
import type { NamedEvidenceExecutor } from './contracts.js';

const callOptionsSchema = z.strictObject({
  releaseId: z.string().trim().min(1).max(256),
  invocationId: z.uuid(),
});

type OracleAgentCallOptions = z.infer<typeof callOptionsSchema>;

export const ORACLE_AGENT_LIMITS = Object.freeze({
  maximumSteps: 3,
  maximumToolCalls: 6,
  maximumOutputTokens: 2_048,
  totalTimeoutMs: 25_000,
  stepTimeoutMs: 10_000,
  maximumPromptCharacters: 8_000,
});

export type AgentTelemetryEvent = Readonly<{
  operation: 'generated';
  invocationId: string;
  releaseId: string;
  toolCalls: number;
  evidenceCount: number;
  durationMs: number;
  outcome: 'success' | 'failure';
}>;

export class OracleAgentError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OracleAgentError';
  }
}

export type OracleAgentAnswer = Readonly<{
  text: string;
  releaseId: string;
  invocationId: string;
  citedEvidenceIds: readonly string[];
  toolCalls: number;
  trace: readonly NamedToolTraceRecord[];
}>;

export type OracleEvidenceAgent = Readonly<{
  policyHash: string;
  model: Readonly<{ provider: 'amazon-bedrock'; modelId: string; region: string }>;
  tools: NamedEvidenceTools;
  ask: (question: string, releaseId: string, signal?: AbortSignal) => Promise<OracleAgentAnswer>;
}>;

function citedEvidenceIds(text: string): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        [...text.matchAll(/\[evidence:(sc:evidence:[a-f0-9]{64})\]/gu)].map(
          (match) => match[1] ?? '',
        ),
      ),
    ].sort(),
  );
}

function validateAnswer(text: string, ledger: InvocationLedger): readonly string[] {
  if (ledger.failures > 0) {
    throw new OracleAgentError(
      'Named evidence dependency failed; model-authored answers are disabled',
    );
  }
  if (
    ledger.calls === 0 &&
    !/\b(?:cannot|refuse|clarif|provide|specify|missing|unsupported)\b/iu.test(text)
  ) {
    throw new OracleAgentError('Model authored an evidence answer without a named tool call');
  }
  const allMentionedIds = [...text.matchAll(/sc:evidence:[a-f0-9]{64}/gu)].map((match) => match[0]);
  for (const evidenceId of allMentionedIds) {
    if (!ledger.evidenceIds.has(evidenceId)) {
      throw new OracleAgentError('Model response cited an evidence ID not returned by a tool');
    }
  }
  const citations = citedEvidenceIds(text);
  const hasPositiveEvidence =
    ledger.supportStates.has('supported') || ledger.supportStates.has('proxy');
  if (hasPositiveEvidence && citations.length === 0) {
    throw new OracleAgentError('Model response omitted required evidence citations');
  }
  if (
    (ledger.supportStates.has('unknown') || ledger.supportStates.has('unsupported')) &&
    !/\b(?:unknown|unsupported|not supported|insufficient evidence)\b/iu.test(text)
  ) {
    throw new OracleAgentError('Model response failed to preserve an unknown or unsupported state');
  }
  return citations;
}

export function createOracleEvidenceAgent(
  input: Readonly<{
    gateway: OracleModelGateway;
    semanticPolicy: SemanticPolicy;
    executor: NamedEvidenceExecutor | undefined;
    telemetry?: (event: AgentTelemetryEvent) => void;
  }>,
): OracleEvidenceAgent {
  if (input.executor === undefined) {
    throw new OracleAgentError(
      'Named evidence executor is required; fixtures and fallbacks are forbidden',
    );
  }
  if (input.gateway.semanticPolicyHash !== input.semanticPolicy.hash) {
    throw new OracleAgentError('Agent semantic policy drift detected');
  }

  const tools = createNamedEvidenceTools(input.executor);
  const ledgers = new Map<string, InvocationLedger>();
  const agent = new ToolLoopAgent<OracleAgentCallOptions, NamedEvidenceTools>({
    id: 'oracle-property-evidence-agent',
    model: input.gateway.model,
    instructions: ORACLE_AGENT_PROMPT_POLICY,
    tools,
    toolChoice: 'auto',
    maxOutputTokens: ORACLE_AGENT_LIMITS.maximumOutputTokens,
    temperature: 0,
    stopWhen: [
      stepCountIs(ORACLE_AGENT_LIMITS.maximumSteps),
      ({ steps }) =>
        steps.reduce((count, step) => count + step.toolCalls.length, 0) >=
        ORACLE_AGENT_LIMITS.maximumToolCalls,
    ],
    callOptionsSchema,
    prepareCall: ({ options, ...call }) => {
      const ledger = ledgers.get(options.invocationId);
      if (ledger?.releaseId !== options.releaseId) {
        throw new OracleAgentError('Agent invocation ledger is missing or release-mismatched');
      }
      return { ...call, experimental_context: { ledger } };
    },
  });

  return Object.freeze({
    policyHash: input.semanticPolicy.hash,
    model: Object.freeze({
      provider: 'amazon-bedrock' as const,
      modelId: input.gateway.modelId,
      region: input.gateway.region,
    }),
    tools,
    ask: async (question, releaseId, signal) => {
      const normalizedQuestion = question.trim();
      if (
        normalizedQuestion.length === 0 ||
        normalizedQuestion.length > ORACLE_AGENT_LIMITS.maximumPromptCharacters
      ) {
        throw new OracleAgentError('Agent question is empty or exceeds its bounded input limit');
      }
      const invocationId = crypto.randomUUID();
      const ledger: InvocationLedger = {
        releaseId,
        calls: 0,
        failures: 0,
        evidenceIds: new Set(),
        supportStates: new Set(),
        trace: [],
      };
      ledgers.set(invocationId, ledger);
      const startedAt = Date.now();
      try {
        const result = await agent.generate({
          prompt: normalizedQuestion,
          options: { releaseId, invocationId },
          timeout: {
            totalMs: ORACLE_AGENT_LIMITS.totalTimeoutMs,
            stepMs: ORACLE_AGENT_LIMITS.stepTimeoutMs,
          },
          ...(signal === undefined ? {} : { abortSignal: signal }),
        });
        const citations = validateAnswer(result.text, ledger);
        input.telemetry?.({
          operation: 'generated',
          invocationId,
          releaseId,
          toolCalls: ledger.calls,
          evidenceCount: ledger.evidenceIds.size,
          durationMs: Date.now() - startedAt,
          outcome: 'success',
        });
        return Object.freeze({
          text: result.text,
          releaseId,
          invocationId,
          citedEvidenceIds: citations,
          toolCalls: ledger.calls,
          trace: Object.freeze([...ledger.trace]),
        });
      } catch (error) {
        input.telemetry?.({
          operation: 'generated',
          invocationId,
          releaseId,
          toolCalls: ledger.calls,
          evidenceCount: ledger.evidenceIds.size,
          durationMs: Date.now() - startedAt,
          outcome: 'failure',
        });
        if (error instanceof OracleAgentError) throw error;
        throw new OracleAgentError('Oracle Bedrock agent request failed without fallback', {
          cause: error,
        });
      } finally {
        ledgers.delete(invocationId);
      }
    },
  });
}
