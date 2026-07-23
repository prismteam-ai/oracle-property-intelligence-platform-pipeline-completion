import { sourceDescriptorSchema, type SourceDescriptor } from '@oracle/contracts/source';
import { sourceIdSchema } from '@oracle/contracts/ids';
import { describe, expect, it } from 'vitest';

import {
  DuplicateSourceIdError,
  SourceAdapterRegistry,
  UnsupportedSourceContractVersionError,
} from '../registry.js';

const HASH = 'a'.repeat(64);

function descriptor(slug: string, contractVersion = '2.0.0'): SourceDescriptor {
  return sourceDescriptorSchema.parse({
    sourceId: sourceIdSchema.parse(`sc:source:${slug}`),
    contractVersion,
    name: `Source ${slug}`,
    authority: {
      authorityType: 'official_government',
      organization: 'Santa Clara County',
      jurisdiction: 'Santa Clara County, California',
      canonicalUrl: 'https://data.sccgov.org/',
      authorityRank: 1,
    },
    acquisitionMethod: 'bulk_download',
    encodings: ['csv'],
    entityKinds: ['property'],
    defaultVisibility: 'public',
    license: {
      licenseSnapshotId: `sc:license:${slug}:${HASH}`,
      capturedAt: '2026-07-17T00:00:00.000Z',
      title: 'Test terms',
      canonicalUrl: 'https://data.sccgov.org/terms',
      termsSha256: HASH,
      redistribution: 'approved',
      containsPersonalData: false,
      attribution: ['Santa Clara County'],
      limitations: [],
    },
    ratePolicy: {
      maxRequestsPerWindow: 10,
      windowMs: 1_000,
      maxConcurrency: 1,
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitter: 'none',
      respectRetryAfter: true,
    },
    freshnessSemantics: 'Snapshot as reported by the authority',
  });
}

const registration = (value: SourceDescriptor) => ({ describe: () => value });

describe('source adapter registry', () => {
  it('registers provider composition in deterministic source-ID order', () => {
    const registry = new SourceAdapterRegistry();
    registry.registerAll([registration(descriptor('zeta')), registration(descriptor('alpha'))]);

    expect(registry.descriptors().map(({ sourceId }) => sourceId)).toEqual([
      'sc:source:alpha',
      'sc:source:zeta',
    ]);
    expect(registry.require(sourceIdSchema.parse('sc:source:alpha'))).toBeDefined();
  });

  it('snapshots the validated descriptor at registration time', () => {
    const registry = new SourceAdapterRegistry();
    let current = descriptor('stable');
    registry.register({ describe: () => current });
    current = descriptor('changed-later');

    expect(registry.descriptors().map(({ sourceId }) => sourceId)).toEqual(['sc:source:stable']);
    expect(Object.isFrozen(registry.descriptors()[0]?.ratePolicy)).toBe(true);
  });

  it('rejects a duplicate source atomically even across versions', () => {
    const registry = new SourceAdapterRegistry();
    expect(() =>
      registry.registerAll([
        registration(descriptor('parcels')),
        registration(descriptor('parcels')),
      ]),
    ).toThrow(DuplicateSourceIdError);
    expect(registry.descriptors()).toEqual([]);
  });

  it('rejects malformed and unsupported contract versions', () => {
    const registry = new SourceAdapterRegistry(['1.0.0', '2.0.0']);
    expect(() => registry.register(registration(descriptor('streaming', '2.0.0')))).not.toThrow();
    expect(() => registry.register(registration(descriptor('parcels', '3.0.0')))).toThrow(
      UnsupportedSourceContractVersionError,
    );
    const malformed: SourceDescriptor = {
      ...descriptor('malformed'),
      contractVersion: 'v1',
    };
    expect(() => registry.register(registration(malformed))).toThrow();
  });
});
