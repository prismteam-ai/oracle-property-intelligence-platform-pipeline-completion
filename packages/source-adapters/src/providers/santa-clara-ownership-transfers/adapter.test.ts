import { readFile } from 'node:fs/promises';

import type { ArtifactStore } from '@oracle/artifacts/artifact-store';
import type { CheckpointStore } from '@oracle/artifacts/checkpoint-store';
import { snapshotIdSchema, sourceIdSchema } from '@oracle/contracts/ids';
import {
  acquisitionPlanSchema,
  acquisitionRequestSchema,
  sourceCheckpointSchema,
} from '@oracle/contracts/source';
import { describe, expect, it } from 'vitest';

import type { AcquisitionContext, DiscoveryContext, PlanningContext } from '../../spi/adapter.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../spi/http.js';
import {
  assessNoRecordedExchange,
  createOwnershipTransferCapability,
  deduplicateOwnershipIndexRows,
  projectOwnershipRows,
  validateOwnershipIndexRow,
} from './capability.js';
import {
  createSantaClaraOwnershipTransferCapabilityAdapter,
  SANTA_CLARA_OWNERSHIP_TRANSFER_DESCRIPTOR,
} from './adapter.js';
import { OWNERSHIP_CAPABILITY_PAGE_SPECS, OWNERSHIP_TRANSFER_SOURCE_ID } from './constants.js';
import type { OwnershipIndexRow } from './types.js';

const AT = '2026-07-17T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const SNAPSHOT_ID = snapshotIdSchema.parse(`sc:snapshot:santa-clara-ownership-transfers:${HASH}`);
const FIXTURE_ROOT = new URL(
  '../../../../testkit/src/sources/santa-clara-ownership-transfers/',
  import.meta.url,
);

async function fixture(file: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(file, FIXTURE_ROOT)));
}

function body(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* stream() {
    await Promise.resolve();
    yield Uint8Array.from(bytes);
  })();
}

function response(
  bytes: Uint8Array,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({
      'content-type': 'text/html; charset=utf-8',
      'last-modified': 'Fri, 17 Jul 2026 00:00:00 GMT',
      ...headers,
    }),
    body: body(bytes),
  });
}

type Step = HttpResponse | Readonly<{ throws: Error }>;

class UrlScriptedHttp implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly #steps: Map<string, Step[]>;

  public constructor(entries: readonly (readonly [string, readonly Step[]])[]) {
    this.#steps = new Map(entries.map(([url, steps]) => [url, [...steps]]));
  }

  public send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    this.requests.push(request);
    const step = this.#steps.get(request.url)?.shift();
    if (step === undefined) throw new Error(`Missing scripted response for ${request.url}`);
    return 'throws' in step ? Promise.reject(step.throws) : Promise.resolve(step);
  }
}

const clock = Object.freeze({ now: () => AT });

async function officialHttp(
  overrides: Readonly<Partial<Record<string, readonly Step[]>>> = {},
): Promise<UrlScriptedHttp> {
  const files = [
    'official-data-sales-excerpt.html',
    'official-research-access-excerpt.html',
    'official-fee-schedule-excerpt.html',
  ];
  const entries: [string, Step[]][] = [];
  for (const [index, spec] of OWNERSHIP_CAPABILITY_PAGE_SPECS.entries()) {
    const scripted = overrides[spec.url];
    entries.push([
      spec.url,
      scripted === undefined ? [response(await fixture(files[index] ?? 'missing'))] : [...scripted],
    ]);
  }
  return new UrlScriptedHttp(entries);
}

function discoveryContext(
  http: HttpTransport,
  delays: number[] = [],
  signal = new AbortController().signal,
): DiscoveryContext {
  return {
    http,
    clock,
    signal,
    ratePolicy: SANTA_CLARA_OWNERSHIP_TRANSFER_DESCRIPTOR.ratePolicy,
    delay: Object.freeze({
      wait: (milliseconds: number, delaySignal: AbortSignal) => {
        delaySignal.throwIfAborted();
        delays.push(milliseconds);
        return Promise.resolve();
      },
    }),
  };
}

function planningContext(signal = new AbortController().signal): PlanningContext {
  return { clock, signal };
}

function acquisitionContext(
  http: HttpTransport,
  signal = new AbortController().signal,
): AcquisitionContext {
  return {
    ...discoveryContext(http, [], signal),
    artifactStore: {} as ArtifactStore,
    checkpointStore: {} as CheckpointStore,
  };
}

function request() {
  return acquisitionRequestSchema.parse({
    sourceId: OWNERSHIP_TRANSFER_SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    requestedAt: AT,
    mode: 'full',
    requestedSourceAsOf: {
      state: 'unknown',
      reason: 'No subscribed index snapshot has been acquired',
    },
  });
}

function blockedPlan() {
  return acquisitionPlanSchema.parse({
    sourceId: OWNERSHIP_TRANSFER_SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    contractVersion: '1.0.0',
    plannedAt: AT,
    items: [
      {
        requestKey: 'forbidden-owner-index',
        sequence: 0,
        method: 'GET',
        url: 'https://example.invalid/blocked-owner-index',
        encoding: 'other',
        expectedMediaTypes: ['application/octet-stream'],
      },
    ],
  });
}

function checkpoint() {
  return sourceCheckpointSchema.parse({
    sourceId: OWNERSHIP_TRANSFER_SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    contractVersion: '1.0.0',
    cursor: 'sequence:0',
    nextSequence: 0,
    completedRequestKeys: [],
    acquiredArtifactIds: [],
    updatedAt: AT,
    complete: false,
  });
}

function validatedRow(overrides: Readonly<Record<string, unknown>> = {}): OwnershipIndexRow {
  const result = validateOwnershipIndexRow({
    sourceVersion: `sha256:${'c'.repeat(64)}`,
    artifactSha256: 'd'.repeat(64),
    ordinal: 1,
    instrumentDocumentNumber: '25123456',
    recordingDate: '2020-06-01',
    documentType: 'GRANT DEED',
    partyRole: 'grantee',
    partyName: 'SYNTHETIC PARTY A',
    apn: null,
    address: null,
    ...overrides,
  });
  if (result.status !== 'accepted') throw new Error('Expected synthetic row to validate');
  return result.record;
}

describe('Santa Clara ownership/transfer capability adapter', () => {
  it('describes an official, restricted, paid manual route without a public-rights claim', () => {
    expect(createSantaClaraOwnershipTransferCapabilityAdapter().describe()).toMatchObject({
      sourceId: 'sc:source:santa-clara-ownership-transfers',
      acquisitionMethod: 'manual_snapshot',
      entityKinds: ['ownership-event', 'ownership-capability'],
      defaultVisibility: 'restricted',
      authority: { authorityRank: 100 },
      license: { redistribution: 'unknown', containsPersonalData: true },
    });
  });

  it('discovers the official source facts and returns a deterministic blocked capability', async () => {
    const adapter = createSantaClaraOwnershipTransferCapabilityAdapter();
    const http = await officialHttp();
    const capability = await adapter.inspectCapability(discoveryContext(http));
    const repeated = await adapter.inspectCapability(discoveryContext(await officialHttp()));
    const discovery = await adapter.discover(discoveryContext(await officialHttp()));

    expect(capability).toMatchObject({
      supportState: 'blocked',
      sourceProduct: 'Grantor and grantee index',
      access: {
        route: 'paid_sftp_subscription',
        unauthenticatedBulkOrApi: false,
        currentSnapshotAcquired: false,
      },
      actualSourceFields: {
        instrumentDocumentNumber: 'available',
        recordingDate: 'available',
        partyRole: 'grantor_or_grantee',
        apn: 'not_in_standard_index',
        address: 'not_in_standard_index',
      },
      coverage: {
        startsOn: null,
        endsOn: null,
        expectedRecords: null,
        observedRecords: 0,
      },
      defaultVisibility: 'restricted',
      publicProjection: 'denied',
    });
    expect(capability.sourceVersion).toBe(repeated.sourceVersion);
    expect(capability.lineage).toHaveLength(3);
    expect(capability.lineage.every((page) => /^[a-f0-9]{64}$/u.test(page.sha256))).toBe(true);
    expect(discovery).toMatchObject({ complete: false, sourceId: OWNERSHIP_TRANSFER_SOURCE_ID });
    expect(discovery.resources).toHaveLength(3);
    expect(discovery.limitations.join(' ')).toContain('Missing rows cannot support');
  });

  it('retries transient official-page failures, honors Retry-After, and aborts without retry', async () => {
    const firstSpec = OWNERSHIP_CAPABILITY_PAGE_SPECS[0];
    if (firstSpec === undefined) throw new Error('Missing data-sales page spec');
    const fixtureBytes = await fixture('official-data-sales-excerpt.html');
    const delays: number[] = [];
    const http = await officialHttp({
      [firstSpec.url]: [
        response(new Uint8Array(), 503, { 'retry-after': '1' }),
        response(fixtureBytes),
      ],
    });
    await createSantaClaraOwnershipTransferCapabilityAdapter().discover(
      discoveryContext(http, delays),
    );
    expect(delays).toEqual([1_000]);
    expect(http.requests.filter((item) => item.url === firstSpec.url)).toHaveLength(2);

    const controller = new AbortController();
    controller.abort();
    const abortedHttp = await officialHttp();
    await expect(
      createSantaClaraOwnershipTransferCapabilityAdapter().discover(
        discoveryContext(abortedHttp, [], controller.signal),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedHttp.requests).toHaveLength(0);
  });

  it('fails closed on source schema/media drift and bounded retry exhaustion', async () => {
    const firstSpec = OWNERSHIP_CAPABILITY_PAGE_SPECS[0];
    if (firstSpec === undefined) throw new Error('Missing data-sales page spec');
    const missingMarker = new TextEncoder().encode('<html><body>changed</body></html>');
    await expect(
      createSantaClaraOwnershipTransferCapabilityAdapter().discover(
        discoveryContext(await officialHttp({ [firstSpec.url]: [response(missingMarker)] })),
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });

    await expect(
      createSantaClaraOwnershipTransferCapabilityAdapter().discover(
        discoveryContext(
          await officialHttp({
            [firstSpec.url]: [
              response(await fixture('official-data-sales-excerpt.html'), 200, {
                'content-type': 'application/json',
              }),
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });

    await expect(
      createSantaClaraOwnershipTransferCapabilityAdapter().discover(
        discoveryContext(
          await officialHttp({
            [firstSpec.url]: [response(new Uint8Array([0xff, 0xfe, 0xfd]))],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });

    const unavailable = Array.from({ length: 4 }, () => ({
      throws: new Error('network unavailable'),
    }));
    const delays: number[] = [];
    await expect(
      createSantaClaraOwnershipTransferCapabilityAdapter().discover(
        discoveryContext(await officialHttp({ [firstSpec.url]: unavailable }), delays),
      ),
    ).rejects.toMatchObject({ code: 'TRANSIENT_SOURCE' });
    expect(delays).toEqual([250, 500, 1_000]);
  });

  it('rejects plan/acquisition and proves checkpoint or retry cannot bypass the gate', async () => {
    const adapter = createSantaClaraOwnershipTransferCapabilityAdapter();
    const discovery = await adapter.discover(discoveryContext(await officialHttp()));
    await expect(adapter.plan(request(), discovery, planningContext())).rejects.toMatchObject({
      code: 'TERMS_ACCESS',
      retryable: false,
    });

    const noHttp = new UrlScriptedHttp([]);
    await expect(async () => {
      for await (const artifact of adapter.acquire(
        blockedPlan(),
        checkpoint(),
        acquisitionContext(noHttp),
      )) {
        void artifact;
      }
    }).rejects.toMatchObject({ code: 'TERMS_ACCESS' });
    expect(noHttp.requests).toHaveLength(0);

    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const artifact of adapter.acquire(
        blockedPlan(),
        checkpoint(),
        acquisitionContext(noHttp, controller.signal),
      )) {
        void artifact;
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ownership transfer validation and evidence semantics', () => {
  it('rejects malformed document, role, APN/address, date, and lineage identifiers', () => {
    const malformedArtifact = validateOwnershipIndexRow({
      sourceVersion: 'moving-latest',
      artifactSha256: 'bad',
      ordinal: 1,
      instrumentDocumentNumber: '25123456',
      recordingDate: '2026-02-28',
      documentType: 'GRANT DEED',
      partyRole: 'grantor',
      partyName: 'SYNTHETIC PARTY',
      apn: null,
      address: null,
    });
    expect(malformedArtifact.status).toBe('rejected');
    if (malformedArtifact.status === 'rejected') {
      expect(malformedArtifact.issues.map((issue) => issue.code).sort()).toEqual([
        'MALFORMED_ARTIFACT_HASH',
        'MALFORMED_SOURCE_VERSION',
      ]);
    }

    const sourceFieldFailures = validateOwnershipIndexRow({
      sourceVersion: `sha256:${'c'.repeat(64)}`,
      artifactSha256: 'd'.repeat(64),
      ordinal: 0,
      instrumentDocumentNumber: '??',
      recordingDate: '2026-02-30',
      documentType: '',
      partyRole: 'owner',
      partyName: '',
      apn: '123-45-678',
      address: 'SYNTHETIC ADDRESS VALUE',
    });
    expect(sourceFieldFailures.status).toBe('rejected');
    if (sourceFieldFailures.status === 'rejected') {
      expect(sourceFieldFailures.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'MALFORMED_DOCUMENT_NUMBER',
          'MALFORMED_RECORDING_DATE',
          'MISSING_DOCUMENT_TYPE',
          'MALFORMED_PARTY_ROLE',
          'MISSING_PARTY_NAME',
          'UNSUPPORTED_APN_FIELD',
          'UNSUPPORTED_ADDRESS_FIELD',
          'MALFORMED_ORDINAL',
        ]),
      );
    }
  });

  it('deduplicates repeated instrument-party rows deterministically without merging distinct roles', () => {
    const first = validatedRow();
    const duplicate = validatedRow({ ordinal: 2 });
    const grantor = validatedRow({
      ordinal: 3,
      partyRole: 'grantor',
      partyName: 'SYNTHETIC PARTY B',
    });
    const output = deduplicateOwnershipIndexRows([grantor, duplicate, first]);
    expect(output).toHaveLength(2);
    expect(output.map((row) => row.partyRole).sort()).toEqual(['grantee', 'grantor']);
    expect(deduplicateOwnershipIndexRows([first, grantor, duplicate])).toEqual(output);
  });

  it('keeps blocked and partial ten-year evidence unknown while complete coverage can decide', () => {
    const blocked = createOwnershipTransferCapability({
      supportState: 'blocked',
      measuredAt: AT,
      lineage: [],
    });
    const partial = createOwnershipTransferCapability({
      supportState: 'partial',
      measuredAt: AT,
      lineage: [],
      currentSnapshotAcquired: true,
      startsOn: '2020-01-01',
      endsOn: '2026-07-17',
      observedRecords: 10,
      titleTransferDocumentCoverage: 'partial',
      propertyLinkage: 'address_candidate',
      chainCompleteness: 'partial',
    });
    const complete = createOwnershipTransferCapability({
      supportState: 'complete',
      measuredAt: AT,
      lineage: [],
      currentSnapshotAcquired: true,
      startsOn: '2010-01-01',
      endsOn: '2026-07-17',
      expectedRecords: 1,
      observedRecords: 1,
      titleTransferDocumentCoverage: 'complete',
      propertyLinkage: 'authoritative_apn',
      chainCompleteness: 'verified',
    });
    expect(
      assessNoRecordedExchange({
        capability: blocked,
        rows: [],
        verifiedTransferDocumentNumbers: [],
        asOf: '2026-07-17',
      }),
    ).toMatchObject({
      supportState: 'unsupported',
      noRecordedExchangeInInterval: null,
    });
    expect(
      assessNoRecordedExchange({
        capability: partial,
        rows: [],
        verifiedTransferDocumentNumbers: [],
        asOf: '2026-07-17',
      }),
    ).toMatchObject({
      supportState: 'unknown',
      noRecordedExchangeInInterval: null,
    });
    expect(
      assessNoRecordedExchange({
        capability: complete,
        rows: [],
        verifiedTransferDocumentNumbers: [],
        asOf: '2026-07-17',
      }),
    ).toMatchObject({
      supportState: 'supported',
      noRecordedExchangeInInterval: true,
      interval: { startsOn: '2016-07-17', endsOn: '2026-07-17' },
    });
    expect(
      assessNoRecordedExchange({
        capability: complete,
        rows: [validatedRow({ sourceVersion: complete.sourceVersion })],
        verifiedTransferDocumentNumbers: ['25123456'],
        asOf: '2026-07-17',
      }),
    ).toMatchObject({
      supportState: 'supported',
      noRecordedExchangeInInterval: false,
      latestVerifiedTransferDate: '2020-06-01',
      evidenceDocumentNumbers: ['25123456'],
    });
  });

  it('denies cross-snapshot and cross-source rows before a supported conclusion', () => {
    const complete = createOwnershipTransferCapability({
      supportState: 'complete',
      measuredAt: AT,
      lineage: [],
      currentSnapshotAcquired: true,
      startsOn: '2010-01-01',
      endsOn: '2026-07-17',
      expectedRecords: 1,
      observedRecords: 1,
      titleTransferDocumentCoverage: 'complete',
      propertyLinkage: 'authoritative_apn',
      chainCompleteness: 'verified',
    });
    const crossSnapshot = validatedRow();
    const crossSource = Object.freeze({
      ...validatedRow({ sourceVersion: complete.sourceVersion }),
      sourceId: sourceIdSchema.parse('sc:source:foreign-ownership-index'),
    });

    for (const row of [crossSnapshot, crossSource]) {
      expect(
        assessNoRecordedExchange({
          capability: complete,
          rows: [row],
          verifiedTransferDocumentNumbers: ['25123456'],
          asOf: '2026-07-17',
        }),
      ).toMatchObject({
        supportState: 'unknown',
        noRecordedExchangeInInterval: null,
        evidenceDocumentNumbers: [],
        limitations: [expect.stringContaining('source identity and immutable source version')],
      });
    }
  });

  it('denies public and authenticated projection of owner-bearing rows', () => {
    const rows = [validatedRow()];
    expect(() => projectOwnershipRows(rows, 'public')).toThrow();
    expect(() => projectOwnershipRows(rows, 'authenticated')).toThrow();
    expect(projectOwnershipRows(rows, 'restricted')).toEqual(rows);
  });
});
