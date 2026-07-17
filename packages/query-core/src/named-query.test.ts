import type { AnalyticalQuery, AnalyticalSession } from '@oracle/data-runtime/analytical-runtime';
import { namedQueryDefinitionSchema } from '@oracle/contracts/query';
import { describe, expect, it } from 'vitest';

import { NamedQueryRegistry } from './named-query.js';

type PropertyRow = Readonly<{ property_id: string }>;

class RecordingSession implements AnalyticalSession {
  readonly queries: AnalyticalQuery[] = [];

  // The generic is required by the polymorphic AnalyticalSession port.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async execute<TRow extends Readonly<Record<string, unknown>>>(query: AnalyticalQuery) {
    await Promise.resolve();
    this.queries.push(query);
    return {
      rows: [{ property_id: 'sc:entity:property:1' }] as unknown as readonly TRow[],
      elapsedMs: 2,
      scannedBytes: 64,
      truncated: false,
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.resolve();
  }
}

const contract = namedQueryDefinitionSchema.parse({
  name: 'search_properties',
  contractVersion: '1.0.0',
  description: 'Find properties by normalized city.',
  maximumScanBytes: 1_000_000,
  maximumResults: 100,
  timeoutMs: 2_000,
  deterministicSort: [{ field: 'property_id', direction: 'asc', nulls: 'last' }],
  maximumVisibility: 'public',
});

const implementation = {
  contract,
  statement: 'select property_id from property_search where city = ? order by property_id',
  parseInput(value: unknown): Readonly<{ city: string }> {
    if (typeof value !== 'object' || value === null || !('city' in value)) {
      throw new TypeError('city is required');
    }
    const city = value.city;
    if (typeof city !== 'string' || city.length === 0) {
      throw new TypeError('city must be a non-empty string');
    }
    return { city };
  },
  parseRow(value: unknown): PropertyRow {
    if (typeof value !== 'object' || value === null || !('property_id' in value)) {
      throw new TypeError('property_id is required');
    }
    const propertyId = value.property_id;
    if (typeof propertyId !== 'string') {
      throw new TypeError('property_id must be a string');
    }
    return { property_id: propertyId };
  },
  parameters(input: Readonly<{ city: string }>) {
    return [input.city];
  },
} as const;

describe('named query registry', () => {
  it('registers and executes only a canonical, bounded operation', async () => {
    const registry = new NamedQueryRegistry();
    const session = new RecordingSession();
    registry.register(implementation);

    await expect(
      registry.execute<PropertyRow>({
        name: 'search_properties',
        contractVersion: '1.0.0',
        input: { city: 'Palo Alto' },
        session,
      }),
    ).resolves.toMatchObject({
      name: 'search_properties',
      contractVersion: '1.0.0',
      rows: [{ property_id: 'sc:entity:property:1' }],
    });
    expect(session.queries[0]).toMatchObject({
      operation: 'search_properties@1.0.0',
      parameters: ['Palo Alto'],
      timeoutMs: 2_000,
      maximumScanBytes: 1_000_000,
      maximumRows: 100,
    });
  });

  it('rejects collisions, invalid canonical contracts, unknown versions, and invalid inputs', async () => {
    const registry = new NamedQueryRegistry();
    registry.register(implementation);
    expect(() => registry.register(implementation)).toThrow(/already registered/u);
    expect(() =>
      registry.register({
        ...implementation,
        contract: { ...contract, maximumResults: 0 },
      }),
    ).toThrow();
    await expect(
      registry.execute({
        name: 'search_properties',
        contractVersion: '2.0.0',
        input: {},
        session: new RecordingSession(),
      }),
    ).rejects.toThrow(/Unknown named query/u);
    await expect(
      registry.execute({
        name: 'search_properties',
        contractVersion: '1.0.0',
        input: {},
        session: new RecordingSession(),
      }),
    ).rejects.toThrow(/city is required/u);
  });

  it('fails closed when a runtime reports a scan-budget breach', async () => {
    const registry = new NamedQueryRegistry();
    registry.register(implementation);
    const session = new RecordingSession();
    // The generic is required by the polymorphic AnalyticalSession port.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    session.execute = async <TRow extends Readonly<Record<string, unknown>>>() => {
      await Promise.resolve();
      return {
        rows: [] as readonly TRow[],
        elapsedMs: 3,
        scannedBytes: contract.maximumScanBytes + 1,
        truncated: false,
      };
    };

    await expect(
      registry.execute({
        name: 'search_properties',
        contractVersion: '1.0.0',
        input: { city: 'Palo Alto' },
        session,
      }),
    ).rejects.toThrow(/scan budget/u);
  });
});
