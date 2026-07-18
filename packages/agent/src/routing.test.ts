import type { OracleModelGateway } from '@oracle/model-gateway';
import { asSchema, type LanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { ORACLE_AGENT_LIMITS, createOracleEvidenceAgent } from './agent.js';
import {
  NAMED_EVIDENCE_TOOL_NAMES,
  type NamedEvidenceEnvelope,
  type NamedEvidenceExecutor,
} from './contracts.js';
import { createSemanticPolicy, type EvidenceCapability } from './policy.js';
import {
  ACTIVE_TOOL_NAMES_BY_QUERY_CLASS,
  ORACLE_AGENT_QUERY_CLASSES,
  classifyOracleAgentQuestion,
  selectActiveNamedEvidenceTools,
  type OracleAgentQueryClass,
} from './routing.js';
import { createNamedEvidenceTools } from './tools.js';

const RELEASE = 'release-2026-07-17';
const EVIDENCE_ID = `sc:evidence:${'a'.repeat(64)}`;
type LanguageModelV3 = Extract<Exclude<LanguageModel, string>, { specificationVersion: 'v3' }>;

const capabilities = Object.fromEntries(
  NAMED_EVIDENCE_TOOL_NAMES.map((name) => [
    name,
    { enabled: true, supportStates: ['supported', 'proxy', 'unknown', 'unsupported'] },
  ]),
) as unknown as Record<(typeof NAMED_EVIDENCE_TOOL_NAMES)[number], EvidenceCapability>;
const policy = createSemanticPolicy({
  capabilities,
  dataDictionary: {
    propertyId: 'Stable public property identifier',
    evidenceId: 'Evidence citation',
  },
});

type RecordedModelCall = Readonly<{
  toolNames: readonly string[];
  allToolsStrict: boolean;
  toolChoice: string | undefined;
}>;

function recordingModel(
  calls: RecordedModelCall[],
  behavior: 'refuse' | 'roof_tool_then_answer' = 'refuse',
): LanguageModel {
  let callIndex = 0;
  return {
    specificationVersion: 'v3',
    provider: 'amazon-bedrock',
    modelId: 'test-profile',
    supportedUrls: {},
    doGenerate: (options) => {
      calls.push(
        Object.freeze({
          toolNames: Object.freeze(
            (options.tools ?? []).map((candidate) =>
              candidate.type === 'function' ? candidate.name : candidate.id,
            ),
          ),
          allToolsStrict: (options.tools ?? []).every(
            (candidate) => candidate.type !== 'function' || candidate.strict === true,
          ),
          toolChoice: options.toolChoice?.type,
        }),
      );
      const useTool = behavior === 'roof_tool_then_answer' && callIndex === 0;
      callIndex += 1;
      return Promise.resolve({
        content: useTool
          ? [
              {
                type: 'tool-call' as const,
                toolCallId: 'roof-call',
                toolName: 'find_roof_age_candidates',
                input: JSON.stringify({ releaseId: RELEASE, minimumAgeYears: 15 }),
              },
            ]
          : [
              {
                type: 'text' as const,
                text:
                  behavior === 'roof_tool_then_answer'
                    ? `Property 1 qualifies [evidence:${EVIDENCE_ID}].`
                    : 'I cannot answer without a more specific supported question.',
              },
            ],
        finishReason: {
          unified: useTool ? ('tool-calls' as const) : ('stop' as const),
          raw: useTool ? 'tool_use' : 'end_turn',
        },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      });
    },
    doStream: () => Promise.resolve({ stream: new ReadableStream() }),
  } satisfies LanguageModelV3;
}

function gateway(model: LanguageModel): OracleModelGateway {
  return {
    provider: 'amazon-bedrock',
    modelId: 'test-profile',
    region: 'us-east-2',
    semanticPolicyHash: policy.hash,
    model,
  };
}

function envelope(): NamedEvidenceEnvelope {
  return {
    schemaVersion: '1.0.0',
    releaseId: RELEASE,
    runId: 'run-1',
    manifestCid: 'bafy-manifest',
    asOf: '2026-07-17T00:00:00.000Z',
    coverage: { state: 'supported' },
    limitations: [],
    data: { properties: [{ propertyId: 'property-1' }] },
    evidence: [
      {
        evidenceId: EVIDENCE_ID as NamedEvidenceEnvelope['evidence'][number]['evidenceId'],
        propertyId: 'property-1',
        supportState: 'supported',
        sourceIds: ['source-1'],
        limitations: [],
      },
    ],
    nextCursor: null,
    truncated: false,
    timing: { elapsedMs: 1, bytesScanned: 100 },
  };
}

function executor(): NamedEvidenceExecutor & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn(() => Promise.resolve(envelope())) };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countOptionalJsonSchemaParameters(schema: unknown): number {
  if (Array.isArray(schema)) {
    const children: readonly unknown[] = schema;
    return children.reduce<number>(
      (count, child) => count + countOptionalJsonSchemaParameters(child),
      0,
    );
  }
  if (!isRecord(schema)) return 0;

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const directAndNestedProperties = Object.entries(properties).reduce(
    (count, [name, child]) =>
      count + (required.has(name) ? 0 : 1) + countOptionalJsonSchemaParameters(child),
    0,
  );
  return Object.entries(schema).reduce(
    (count, [keyword, child]) =>
      keyword === 'properties' || keyword === 'required'
        ? count
        : count + countOptionalJsonSchemaParameters(child),
    directAndNestedProperties,
  );
}

const routingCases = [
  ['dataset', 'Describe this dataset and release information.'],
  ['coverage', 'What dataset coverage and row counts are available?'],
  ['artifacts', 'List the immutable Parquet artifacts and manifest CID.'],
  ['dictionary', 'Show the data dictionary and field definitions.'],
  ['pipeline_runs', 'List pipeline runs and inspect run id run-1.'],
  ['property_lookup', 'Find the property at 123 Main Street by address.'],
  ['property_evidence', 'Show evidence and citations for property property-1.'],
  ['roof_age', 'Which properties have roofs older than 15 years?'],
  ['water_view', 'Find waterfront properties by distance to water.'],
  ['ownership_age', 'Find properties with ownership tenure over 20 years.'],
  ['regional_owner', 'Which properties have a regional owner?'],
  ['transit_walkability', 'Find properties walkable to Caltrain stations.'],
  ['starbucks_walkability', 'Find properties within walking distance of Starbucks.'],
  ['combined_ranking', 'Rank properties by roof age and transit walkability.'],
  ['ambiguous', 'Help me understand what is available.'],
] as const satisfies readonly (readonly [OracleAgentQueryClass, string])[];

describe('Bedrock-bounded request-derived active tools', () => {
  it('classifies every documented query class and exposes exactly that set on the actual model call', async () => {
    expect(routingCases.map(([queryClass]) => queryClass)).toEqual(ORACLE_AGENT_QUERY_CLASSES);
    const reachableTools = new Set<string>();

    for (const [queryClass, question] of routingCases) {
      const calls: RecordedModelCall[] = [];
      const evidence = executor();
      const agent = createOracleEvidenceAgent({
        gateway: gateway(recordingModel(calls)),
        semanticPolicy: policy,
        executor: evidence,
      });

      expect(classifyOracleAgentQuestion(question)).toBe(queryClass);
      expect(selectActiveNamedEvidenceTools(question)).toEqual(
        ACTIVE_TOOL_NAMES_BY_QUERY_CLASS[queryClass],
      );
      await expect(agent.ask(question, RELEASE)).resolves.toMatchObject({ toolCalls: 0 });
      expect(calls).toEqual([
        {
          toolNames: ACTIVE_TOOL_NAMES_BY_QUERY_CLASS[queryClass],
          allToolsStrict: true,
          toolChoice: 'auto',
        },
      ]);
      expect(evidence.execute).not.toHaveBeenCalled();
      calls[0]?.toolNames.forEach((name) => reachableTools.add(name));
    }

    expect(NAMED_EVIDENCE_TOOL_NAMES.filter((name) => reachableTools.has(name))).toEqual(
      NAMED_EVIDENCE_TOOL_NAMES,
    );
  });

  it('counts the live 78 optional parameters recursively and keeps every emitted route at 24 or fewer', async () => {
    const tools = createNamedEvidenceTools(executor());
    const optionalParametersByTool = new Map(
      await Promise.all(
        NAMED_EVIDENCE_TOOL_NAMES.map(
          async (name) =>
            [
              name,
              countOptionalJsonSchemaParameters(await asSchema(tools[name].inputSchema).jsonSchema),
            ] as const,
        ),
      ),
    );
    expect([...optionalParametersByTool.values()].reduce((total, count) => total + count, 0)).toBe(
      78,
    );

    const routeCounts = ORACLE_AGENT_QUERY_CLASSES.map((queryClass) => {
      const activeTools = ACTIVE_TOOL_NAMES_BY_QUERY_CLASS[queryClass];
      expect(activeTools.length).toBeGreaterThan(0);
      expect(activeTools.length).toBeLessThanOrEqual(ORACLE_AGENT_LIMITS.maximumActiveTools);
      expect(new Set(activeTools).size).toBe(activeTools.length);
      expect(
        selectActiveNamedEvidenceTools(
          routingCases.find(([name]) => name === queryClass)?.[1] ?? '',
        ),
      ).toBe(activeTools);
      return activeTools.reduce(
        (total, name) => total + (optionalParametersByTool.get(name) ?? Number.POSITIVE_INFINITY),
        0,
      );
    });

    expect(Math.max(...routeCounts)).toBe(20);
    expect(
      routeCounts.every((count) => count <= ORACLE_AGENT_LIMITS.maximumActiveOptionalParameters),
    ).toBe(true);
  });

  it('uses the same request-derived set for every model step without a router model call', async () => {
    const calls: RecordedModelCall[] = [];
    const evidence = executor();
    const agent = createOracleEvidenceAgent({
      gateway: gateway(recordingModel(calls, 'roof_tool_then_answer')),
      semanticPolicy: policy,
      executor: evidence,
    });

    await expect(agent.ask('Which roofs are older than 15 years?', RELEASE)).resolves.toMatchObject(
      {
        toolCalls: 1,
        citedEvidenceIds: [EVIDENCE_ID],
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.toolNames).toEqual(ACTIVE_TOOL_NAMES_BY_QUERY_CLASS.roof_age);
    expect(calls[1]?.toolNames).toEqual(calls[0]?.toolNames);
    expect(evidence.execute).toHaveBeenCalledTimes(1);
  });

  it('normalizes once and routes a single-step request with exactly one model call', async () => {
    const calls: RecordedModelCall[] = [];
    const agent = createOracleEvidenceAgent({
      gateway: gateway(recordingModel(calls)),
      semanticPolicy: policy,
      executor: executor(),
    });

    await agent.ask('  Describe this dataset.  ', RELEASE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolNames).toEqual(ACTIVE_TOOL_NAMES_BY_QUERY_CLASS.dataset);
  });
});
