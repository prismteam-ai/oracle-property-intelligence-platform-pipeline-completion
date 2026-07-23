import { asSchema, type ToolExecutionOptions } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  NAMED_EVIDENCE_TOOL_NAMES,
  type NamedEvidenceEnvelope,
  type NamedEvidenceExecutor,
} from './contracts.js';
import { createNamedEvidenceTools, type InvocationLedger } from './tools.js';

const RELEASE = 'release-2026-07-17';
const EVIDENCE_ID = `sc:evidence:${'a'.repeat(64)}`;

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

function ledger(): InvocationLedger {
  return {
    releaseId: RELEASE,
    calls: 0,
    failures: 0,
    evidenceIds: new Set(),
    supportStates: new Set(),
    trace: [],
  };
}

function executionOptions(invocationLedger: InvocationLedger): ToolExecutionOptions {
  return {
    toolCallId: 'test-call',
    messages: [],
    experimental_context: { ledger: invocationLedger },
  };
}

describe('Bedrock-compatible named evidence tools', () => {
  it('emits deterministic schemas for all 16 tools without numeric bounds at any depth', async () => {
    const first = createNamedEvidenceTools(executor());
    const second = createNamedEvidenceTools(executor());

    expect(Object.keys(first)).toEqual(NAMED_EVIDENCE_TOOL_NAMES);
    expect(Object.keys(first)).toHaveLength(16);

    const firstSchemas = await Promise.all(
      NAMED_EVIDENCE_TOOL_NAMES.map((name) =>
        Promise.resolve(asSchema(first[name].inputSchema).jsonSchema),
      ),
    );
    const secondSchemas = await Promise.all(
      NAMED_EVIDENCE_TOOL_NAMES.map((name) =>
        Promise.resolve(asSchema(second[name].inputSchema).jsonSchema),
      ),
    );

    expect(firstSchemas).toEqual(secondSchemas);
    expect(JSON.stringify(firstSchemas)).not.toMatch(
      /"(?:exclusiveMaximum|exclusiveMinimum|maximum|minimum)"\s*:/u,
    );
  });

  it('retains strict shape, required fields, enums, and non-numeric constraints', async () => {
    const tools = createNamedEvidenceTools(executor());
    const propertySchema = await asSchema(tools.get_property.inputSchema).jsonSchema;
    const evidenceSchema = await asSchema(tools.get_property_evidence.inputSchema).jsonSchema;
    const roofSchema = await asSchema(tools.find_roof_age_candidates.inputSchema).jsonSchema;

    expect(propertySchema).toMatchObject({
      type: 'object',
      required: ['propertyId'],
      additionalProperties: false,
      properties: {
        releaseId: { type: 'string', minLength: 1 },
        propertyId: { type: 'string', minLength: 1 },
      },
    });
    expect(evidenceSchema).toMatchObject({
      properties: {
        feature: {
          enum: [
            'roof_age',
            'water_view_candidate',
            'ownership_age',
            'regional_owner',
            'transit_walkability',
            'starbucks_walkability',
            'combined_review_score',
          ],
        },
      },
    });
    expect(roofSchema).toMatchObject({
      properties: {
        minimumAgeYears: { type: 'integer' },
      },
    });
  });

  it('validates bounded input before execution and calls the executor exactly once', async () => {
    const evidence = executor();
    const tool = createNamedEvidenceTools(evidence).find_roof_age_candidates;
    const schema = asSchema(tool.inputSchema);
    const validation = await schema.validate?.({
      releaseId: RELEASE,
      minimumAgeYears: 15,
    });

    expect(validation).toMatchObject({ success: true });
    if (validation?.success !== true || tool.execute === undefined) {
      throw new Error('Expected a validated executable tool');
    }
    await tool.execute(validation.value, executionOptions(ledger()));

    expect(evidence.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['below', 0],
    ['above', 201],
  ])('rejects %s-bound input before any executor call', async (_label, minimumAgeYears) => {
    const evidence = executor();
    const tool = createNamedEvidenceTools(evidence).find_roof_age_candidates;
    const schema = asSchema(tool.inputSchema);
    const validation = await schema.validate?.({ releaseId: RELEASE, minimumAgeYears });

    expect(validation).toMatchObject({ success: false });
    expect(evidence.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['below', 0],
    ['above', 201],
  ])(
    'reparses %s-bound input before the authoritative executor',
    async (_label, minimumAgeYears) => {
      const evidence = executor();
      const tool = createNamedEvidenceTools(evidence).find_roof_age_candidates;

      if (tool.execute === undefined) throw new Error('Expected an executable tool');
      await expect(
        tool.execute({ releaseId: RELEASE, minimumAgeYears }, executionOptions(ledger())),
      ).rejects.toThrow();
      expect(evidence.execute).not.toHaveBeenCalled();
    },
  );
});
