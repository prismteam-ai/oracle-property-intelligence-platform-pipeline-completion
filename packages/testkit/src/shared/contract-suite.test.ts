import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  runSourceAdapterContractSuite,
  type SourceAdapterContractHarness,
} from './contract-suite.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function passingHarness(): SourceAdapterContractHarness {
  const sha256 = digest('immutable');
  return {
    checkpointResume: async () =>
      Promise.resolve({
        firstRunArtifactIds: ['artifact:1'],
        firstRunLastCheckpoint: 'page:1',
        resumedFromCheckpoint: 'page:1',
        resumedArtifactIds: ['artifact:2'],
      }),
    pagination: async () =>
      Promise.resolve({
        requestedPageTokens: [null, 'page:2'],
        returnedNextPageTokens: ['page:2', null],
        artifactIds: ['artifact:1', 'artifact:2'],
      }),
    retryClassification: async () =>
      Promise.resolve({
        transientAttempts: 2,
        permanentAttempts: 1,
        abortAttempts: 1,
        transientEventuallySucceeded: true,
      }),
    abortPropagation: async () => Promise.resolve({ signalObserved: true, emissionsAfterAbort: 0 }),
    artifactIntegrity: async () =>
      Promise.resolve({
        expectedSha256: sha256,
        actualSha256: sha256,
        expectedByteSize: 9,
        actualByteSize: 9,
        sha256AfterConsumerMutation: sha256,
      }),
    decodeValidationSeparation: async () =>
      Promise.resolve({
        phaseTrace: ['acquire', 'decode', 'validate', 'normalize', 'summarize'],
        transportCallsAtDecodeStart: 2,
        transportCallsAtDecodeEnd: 2,
        validationInputCount: 4,
        decodedRecordCount: 4,
      }),
    normalizationDeterminism: async () =>
      Promise.resolve({ firstCanonicalJson: '{"a":1}', secondCanonicalJson: '{"a":1}' }),
    sourceIdUniqueness: async () =>
      Promise.resolve({
        registeredSourceIds: ['source:a', 'source:b'],
        duplicateSourceRejected: true,
        unsupportedContractVersionRejected: true,
      }),
    summaryAccounting: async () =>
      Promise.resolve({
        observed: { artifacts: 2, decoded: 4, accepted: 3, rejected: 1, mutations: 5 },
        summarized: { artifacts: 2, decoded: 4, accepted: 3, rejected: 1, mutations: 5 },
      }),
    visibilityPreservation: async () =>
      Promise.resolve({
        input: ['public', 'authenticated', 'restricted', 'prohibited_public'],
        output: ['public', 'authenticated', 'restricted', 'prohibited_public'],
        prohibitedPublicWasPublicationEligible: false,
      }),
  };
}

describe('shared source adapter contract suite', () => {
  it('executes every required check for a conforming provider harness', async () => {
    const report = await runSourceAdapterContractSuite(passingHarness());
    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(10);
    expect(report.violations).toEqual([]);
  });

  it('reports adversarial resume, retry, integrity, and visibility behavior', async () => {
    const harness = passingHarness();
    const broken: SourceAdapterContractHarness = {
      ...harness,
      checkpointResume: async () =>
        Promise.resolve({
          firstRunArtifactIds: ['artifact:1'],
          firstRunLastCheckpoint: 'page:1',
          resumedFromCheckpoint: 'page:0',
          resumedArtifactIds: ['artifact:1'],
        }),
      retryClassification: async () =>
        Promise.resolve({
          transientAttempts: 1,
          permanentAttempts: 2,
          abortAttempts: 2,
          transientEventuallySucceeded: false,
        }),
      artifactIntegrity: async () =>
        Promise.resolve({
          expectedSha256: digest('expected'),
          actualSha256: digest('changed'),
          expectedByteSize: 8,
          actualByteSize: 7,
          sha256AfterConsumerMutation: digest('mutated'),
        }),
      visibilityPreservation: async () =>
        Promise.resolve({
          input: ['restricted', 'prohibited_public'],
          output: ['public', 'public'],
          prohibitedPublicWasPublicationEligible: true,
        }),
    };

    const report = await runSourceAdapterContractSuite(broken);
    expect(report.ok).toBe(false);
    expect(report.violations.map(({ check }) => check)).toEqual(
      expect.arrayContaining([
        'checkpoint_resume',
        'retry_classification',
        'artifact_integrity',
        'visibility_preservation',
      ]),
    );
  });

  it('detects any differing deterministic normalization output', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (first, second) => {
        fc.pre(first !== second);
        const harness: SourceAdapterContractHarness = {
          ...passingHarness(),
          normalizationDeterminism: async () =>
            Promise.resolve({ firstCanonicalJson: first, secondCanonicalJson: second }),
        };
        const report = await runSourceAdapterContractSuite(harness);
        expect(report.violations.some(({ check }) => check === 'normalization_determinism')).toBe(
          true,
        );
      }),
    );
  });
});
