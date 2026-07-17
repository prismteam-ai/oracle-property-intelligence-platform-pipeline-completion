import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type {
  ArtifactBody,
  ArtifactByteRange,
  ArtifactStore,
  ImmutableArtifactWrite,
  StoredArtifact,
} from '@oracle/artifacts/artifact-store';
import type {
  CheckpointCommit,
  CheckpointCommitResult,
  CheckpointEnvelope,
  CheckpointStore,
  CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';
import { canonicalMutationSchema } from '@oracle/contracts/canonical/mutation';
import {
  acquisitionRequestSchema,
  sourceCheckpointSchema,
  type SourceCheckpoint,
} from '@oracle/contracts/source';
import { runIdSchema } from '@oracle/contracts/ids';
import { describe, expect, it } from 'vitest';

import type {
  AcquisitionContext,
  DecodeContext,
  DiscoveryContext,
  PlanningContext,
  SourceRunObservation,
} from '../../spi/adapter.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../spi/http.js';
import { sha256Hex } from '../../spi/bytes.js';
import { createOsmPedestrianGraphAdapter } from './adapter.js';
import {
  GEOFABRIK_NORCAL_260715_DISTRIBUTOR_IDENTITY,
  OSM_ATTRIBUTION,
  OSM_NOTICE,
  OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
} from './constants.js';
import { createPedestrianGraphReferenceMutation, normalizeOsmPedestrianGraph } from './graph.js';
import type {
  OsmDecodedElement,
  OsmPbfDecoder,
  PinnedOsmExtract,
  ValidatedOsmElement,
  ValidatedOsmPedestrianRecord,
} from './types.js';

const AT = '2026-07-17T13:01:50.000Z';
const SOURCE_AS_OF = '2026-07-15T20:00:00.000Z';
const PBF_TRANSPORT_SENTINEL = new TextEncoder().encode(
  'pbf-decoder-boundary:official-osm-api-excerpt',
);
const PBF_SHA256 = sha256Hex(PBF_TRANSPORT_SENTINEL);
const SNAPSHOT_ID = `sc:snapshot:osm-pedestrian-graph:${PBF_SHA256}` as const;
const ARTIFACT_ID = `sc:artifact:sha256:${PBF_SHA256}` as const;
const RUN_ID = runIdSchema.parse(`sc:run:${'9'.repeat(64)}`);

const TEST_EXTRACT: PinnedOsmExtract = Object.freeze({
  extractId: 'test-official-osm-api-excerpt-260717',
  url: 'https://fixtures.example.test/osm/test-official-osm-api-excerpt-260717.osm.pbf',
  distributor: 'Test boundary backed by the official OpenStreetMap API excerpt',
  extractTimestamp: SOURCE_AS_OF,
  expectedByteSize: PBF_TRANSPORT_SENTINEL.byteLength,
  expectedSha256: PBF_SHA256,
  expectedEtag: '"fixture-pbf"',
  expectedLastModified: AT,
  bounds: [-122.0775, 37.3935, -122.0755, 37.395] as const,
  distributorChecksum: Object.freeze({ algorithm: 'sha256', value: PBF_SHA256 }),
});

interface OfficialApiElement {
  readonly type: 'node' | 'way';
  readonly id: number;
  readonly version: number;
  readonly timestamp: string;
  readonly lat?: number;
  readonly lon?: number;
  readonly nodes?: readonly number[];
  readonly tags?: Readonly<Record<string, string>>;
}

async function officialElements(): Promise<readonly OsmDecodedElement[]> {
  const url = new URL(
    '../../../../testkit/src/sources/osm-pedestrian-graph/official-osm-api-excerpt.json',
    import.meta.url,
  );
  const fixture = JSON.parse(await readFile(url, 'utf8')) as {
    readonly elements: readonly OfficialApiElement[];
  };
  return fixture.elements.map((element) =>
    element.type === 'node'
      ? Object.freeze({
          type: 'node' as const,
          id: element.id,
          version: element.version,
          timestamp: element.timestamp,
          latitude: element.lat,
          longitude: element.lon,
          tags: element.tags,
        })
      : Object.freeze({
          type: 'way' as const,
          id: element.id,
          version: element.version,
          timestamp: element.timestamp,
          nodeRefs: element.nodes,
          tags: element.tags,
        }),
  );
}

class FixtureDecoder implements OsmPbfDecoder {
  readonly #elements: readonly OsmDecodedElement[];
  readonly seenByteHashes: string[] = [];
  readonly signals: AbortSignal[] = [];

  public constructor(elements: readonly OsmDecodedElement[]) {
    this.#elements = elements;
  }

  public async *decode(bytes: Uint8Array, signal: AbortSignal): AsyncIterable<OsmDecodedElement> {
    this.seenByteHashes.push(sha256Hex(bytes));
    this.signals.push(signal);
    for (const element of this.#elements) {
      signal.throwIfAborted();
      await Promise.resolve();
      yield element;
    }
  }
}

function stream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* byteStream() {
    await Promise.resolve();
    yield Uint8Array.from(bytes);
  })();
}

function response(
  status: number,
  bytes = new Uint8Array(),
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({
      'content-length': String(TEST_EXTRACT.expectedByteSize),
      'content-type': 'application/octet-stream',
      etag: TEST_EXTRACT.expectedEtag ?? '',
      'last-modified': 'Fri, 17 Jul 2026 13:01:50 GMT',
      ...headers,
    }),
    body: stream(bytes),
  });
}

class ScriptedHttp implements HttpTransport {
  readonly #responses: HttpResponse[];
  readonly requests: HttpRequest[] = [];

  public constructor(responses: readonly HttpResponse[]) {
    this.#responses = [...responses];
  }

  public send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    this.requests.push(request);
    const next = this.#responses.shift();
    if (next === undefined) throw new Error(`No response for ${request.method} ${request.url}`);
    return Promise.resolve(next);
  }
}

async function collectArtifactBody(body: ArtifactBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return Uint8Array.from(body);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(Uint8Array.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

class TestArtifactStore implements ArtifactStore {
  readonly values = new Map<string, Readonly<{ descriptor: StoredArtifact; bytes: Uint8Array }>>();

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    const bytes = await collectArtifactBody(request.body);
    const sha256 = sha256Hex(bytes);
    if (sha256 !== request.expectedSha256) throw new Error('test store integrity failure');
    const descriptor = Object.freeze({
      logicalKey: request.logicalKey,
      uri: `file:///oracle-test/${encodeURIComponent(request.logicalKey)}`,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256,
      storedAt: AT,
      metadata: request.metadata,
    });
    this.values.set(descriptor.uri, Object.freeze({ descriptor, bytes }));
    return descriptor;
  }

  public head(uri: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(this.values.get(uri)?.descriptor);
  }

  public async *read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    const item = this.values.get(uri);
    if (item === undefined) throw new Error('missing artifact');
    yield range === undefined
      ? Uint8Array.from(item.bytes)
      : item.bytes.slice(range.start, range.endInclusive + 1);
  }
}

class TestCheckpointStore implements CheckpointStore {
  readonly values = new Map<string, CheckpointEnvelope>();

  public load(scope: string): Promise<CheckpointEnvelope | undefined> {
    return Promise.resolve(this.values.get(scope));
  }

  public commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    const current = this.values.get(request.checkpoint.scope);
    if ((current?.revision ?? null) !== request.expectedRevision) {
      return Promise.resolve(Object.freeze({ status: 'conflict', current }));
    }
    this.values.set(request.checkpoint.scope, request.checkpoint);
    return Promise.resolve(Object.freeze({ status: 'committed', checkpoint: request.checkpoint }));
  }
}

const clock = Object.freeze({ now: () => AT });

function delayRecorder(values: number[]) {
  return Object.freeze({
    wait: (milliseconds: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      values.push(milliseconds);
      return Promise.resolve();
    },
  });
}

function adapter(decoder: OsmPbfDecoder) {
  return createOsmPedestrianGraphAdapter({ extract: TEST_EXTRACT, decoder });
}

function discoveryContext(
  http: HttpTransport,
  signal = new AbortController().signal,
  delays: number[] = [],
): DiscoveryContext {
  return {
    http,
    signal,
    clock,
    delay: delayRecorder(delays),
    ratePolicy: adapter(new FixtureDecoder([])).describe().ratePolicy,
  };
}

function planningContext(signal = new AbortController().signal): PlanningContext {
  return { signal, clock };
}

function acquisitionContext(
  http: HttpTransport,
  artifactStore: ArtifactStore,
  checkpointStore: CheckpointStore,
  signal = new AbortController().signal,
  delays: number[] = [],
): AcquisitionContext {
  return {
    ...discoveryContext(http, signal, delays),
    artifactStore,
    checkpointStore,
  };
}

function phaseContext(signal = new AbortController().signal): DecodeContext {
  return {
    signal,
    clock,
    artifactStore: {} as ArtifactStore,
    analyticalRuntime: {} as DecodeContext['analyticalRuntime'],
  };
}

function request() {
  return acquisitionRequestSchema.parse({
    sourceId: OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    requestedAt: AT,
    mode: 'full',
    requestedSourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
  });
}

async function planFor(instance: ReturnType<typeof adapter>) {
  const discovery = await instance.discover(discoveryContext(new ScriptedHttp([response(200)])));
  return instance.plan(request(), discovery, planningContext());
}

async function acquireFixture(instance: ReturnType<typeof adapter>) {
  const plan = await planFor(instance);
  const artifacts = new TestArtifactStore();
  const checkpoints = new TestCheckpointStore();
  const acquired = [];
  for await (const artifact of instance.acquire(
    plan,
    undefined,
    acquisitionContext(
      new ScriptedHttp([response(200, PBF_TRANSPORT_SENTINEL)]),
      artifacts,
      checkpoints,
    ),
  )) {
    acquired.push(artifact);
  }
  const first = acquired[0];
  if (first === undefined) throw new Error('expected acquired fixture');
  return { artifact: first, plan, artifacts, checkpoints };
}

async function validatedOfficialRecords() {
  const elements = await officialElements();
  const decoder = new FixtureDecoder(elements);
  const instance = adapter(decoder);
  const { artifact } = await acquireFixture(instance);
  const records: ValidatedOsmPedestrianRecord[] = [];
  for await (const decoded of instance.decode(artifact, phaseContext())) {
    const outcome = await instance.validate(decoded, phaseContext());
    if (outcome.status !== 'accepted') throw new Error(JSON.stringify(outcome.issues));
    records.push(outcome.record);
  }
  return { instance, decoder, artifact, records };
}

function syntheticRecord(
  base: ValidatedOsmPedestrianRecord,
  element: ValidatedOsmElement,
  ordinal: number,
): ValidatedOsmPedestrianRecord {
  return Object.freeze({
    ...base,
    ordinal,
    recordSha256: createHash('sha256').update(JSON.stringify(element)).digest('hex'),
    element,
  });
}

describe('OSM pedestrian graph adapter', () => {
  it('freezes source identity and ODbL attribution without claiming an unavailable archive SHA', () => {
    const descriptor = adapter(new FixtureDecoder([])).describe();
    expect(descriptor).toMatchObject({
      sourceId: 'sc:source:osm-pedestrian-graph',
      acquisitionMethod: 'static_artifact',
      encodings: ['pbf'],
      license: { redistribution: 'approved' },
    });
    expect(descriptor.license.attribution.join(' ')).toContain('OpenStreetMap');
    expect(descriptor.license.limitations.join(' ')).toContain('Overpass');
    expect(GEOFABRIK_NORCAL_260715_DISTRIBUTOR_IDENTITY).toMatchObject({
      expectedByteSize: 646_753_595,
      distributorChecksum: { algorithm: 'md5', value: 'e30b21d7c7cfd4c9e6f4f11cae3bfaa0' },
      sha256State: 'runtime_required_unavailable_in_repository',
    });
    expect('expectedSha256' in GEOFABRIK_NORCAL_260715_DISTRIBUTOR_IDENTITY).toBe(false);
  });

  it('rejects moving latest URLs, malformed hashes, and invalid bounds', () => {
    const decoder = new FixtureDecoder([]);
    expect(() =>
      createOsmPedestrianGraphAdapter({
        decoder,
        extract: { ...TEST_EXTRACT, url: 'https://example.test/norcal-latest.osm.pbf' },
      }),
    ).toThrow(/immutable dated/u);
    expect(() =>
      createOsmPedestrianGraphAdapter({
        decoder,
        extract: { ...TEST_EXTRACT, expectedSha256: 'bad' },
      }),
    ).toThrow(/SHA-256/u);
    expect(() =>
      createOsmPedestrianGraphAdapter({
        decoder,
        extract: { ...TEST_EXTRACT, bounds: [1, 1, -1, -1] },
      }),
    ).toThrow(/bounds/u);
  });

  it('discovers exact HEAD identity and plans one immutable regional PBF', async () => {
    const instance = adapter(new FixtureDecoder([]));
    const http = new ScriptedHttp([response(200)]);
    const discovery = await instance.discover(discoveryContext(http));
    const plan = await instance.plan(request(), discovery, planningContext());

    expect(http.requests).toEqual([
      expect.objectContaining({ method: 'HEAD', url: TEST_EXTRACT.url }),
    ]);
    expect(discovery.resources[0]).toMatchObject({
      requestKey: TEST_EXTRACT.extractId,
      expectedRecords: null,
      sourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
    });
    expect(plan.items).toEqual([
      expect.objectContaining({ method: 'GET', encoding: 'pbf', url: TEST_EXTRACT.url }),
    ]);
  });

  it('fails closed on HEAD drift and snapshot mismatch', async () => {
    const instance = adapter(new FixtureDecoder([]));
    await expect(
      instance.discover(
        discoveryContext(
          new ScriptedHttp([response(200, new Uint8Array(), { 'content-length': '2' })]),
        ),
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });

    const discovery = await instance.discover(discoveryContext(new ScriptedHttp([response(200)])));
    const wrongRequest = acquisitionRequestSchema.parse({
      ...request(),
      snapshotId: `sc:snapshot:osm-pedestrian-graph:${'a'.repeat(64)}`,
    });
    await expect(instance.plan(wrongRequest, discovery, planningContext())).rejects.toMatchObject({
      code: 'RECORD_QUALITY',
    });
  });

  it('classifies 429, honors Retry-After, checkpoints, and resumes without replay', async () => {
    const instance = adapter(new FixtureDecoder([]));
    const plan = await planFor(instance);
    const artifacts = new TestArtifactStore();
    const checkpoints = new TestCheckpointStore();
    const delays: number[] = [];
    const http = new ScriptedHttp([
      response(429, new Uint8Array(), { 'retry-after': '2' }),
      response(200, PBF_TRANSPORT_SENTINEL),
    ]);
    const acquired = [];
    for await (const artifact of instance.acquire(
      plan,
      undefined,
      acquisitionContext(http, artifacts, checkpoints, new AbortController().signal, delays),
    )) {
      acquired.push(artifact);
    }
    expect(delays).toEqual([2_000]);
    expect(http.requests).toHaveLength(2);
    expect(acquired[0]?.metadata).toMatchObject({
      artifactId: ARTIFACT_ID,
      byteSize: PBF_TRANSPORT_SENTINEL.byteLength,
      sha256: PBF_SHA256,
      licenseSnapshotRef: expect.stringContaining('sc:license:osm-pedestrian-graph:'),
      visibility: 'public',
    });
    const envelope = [...checkpoints.values.values()][0];
    const checkpoint = sourceCheckpointSchema.parse(envelope?.payload);
    expect(checkpoint).toMatchObject({ complete: true, nextSequence: 1 });

    const resumedHttp = new ScriptedHttp([]);
    const resumed = [];
    for await (const artifact of instance.acquire(
      plan,
      checkpoint,
      acquisitionContext(resumedHttp, artifacts, checkpoints),
    )) {
      resumed.push(artifact);
    }
    expect(resumed).toEqual([]);
    expect(resumedHttp.requests).toEqual([]);
  });

  it('rejects byte-integrity mismatch and propagates abort before emission', async () => {
    const instance = adapter(new FixtureDecoder([]));
    const plan = await planFor(instance);
    await expect(async () => {
      for await (const unexpectedArtifact of instance.acquire(
        plan,
        undefined,
        acquisitionContext(
          new ScriptedHttp([response(200, new TextEncoder().encode('corrupt'))]),
          new TestArtifactStore(),
          new TestCheckpointStore(),
        ),
      )) {
        throw new Error(`Unexpected artifact ${unexpectedArtifact.metadata.artifactId}`);
      }
    }).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });

    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const unexpectedArtifact of instance.acquire(
        plan,
        undefined,
        acquisitionContext(
          new ScriptedHttp([]),
          new TestArtifactStore(),
          new TestCheckpointStore(),
          controller.signal,
        ),
      )) {
        throw new Error(`Unexpected artifact ${unexpectedArtifact.metadata.artifactId}`);
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps PBF transport separate from the real decoded-record boundary', async () => {
    const { decoder, artifact, records } = await validatedOfficialRecords();
    expect(decoder.seenByteHashes).toEqual([PBF_SHA256]);
    expect(decoder.signals).toHaveLength(1);
    expect(artifact.metadata.encoding).toBe('pbf');
    expect(records).toHaveLength(18);
    expect(records.filter(({ element }) => element.type === 'node')).toHaveLength(15);
    expect(records.filter(({ element }) => element.type === 'way')).toHaveLength(3);
    expect(
      records.some(({ element }) => element.type === 'node' && element.tags.barrier === 'gate'),
    ).toBe(true);
  });

  it('deduplicates identical decoded elements and rejects conflicting duplicate IDs', async () => {
    const [first] = await officialElements();
    if (first === undefined) throw new Error('missing fixture element');
    const exact = new FixtureDecoder([first, first]);
    const exactAdapter = adapter(exact);
    const { artifact } = await acquireFixture(exactAdapter);
    const exactRecords = [];
    for await (const record of exactAdapter.decode(artifact, phaseContext()))
      exactRecords.push(record);
    expect(exactRecords).toHaveLength(1);

    const conflict: OsmDecodedElement = { ...first, version: 99 };
    const conflictAdapter = adapter(new FixtureDecoder([first, conflict]));
    const conflictArtifact = (await acquireFixture(conflictAdapter)).artifact;
    await expect(async () => {
      for await (const unexpectedRecord of conflictAdapter.decode(
        conflictArtifact,
        phaseContext(),
      )) {
        expect(unexpectedRecord.featureId).toBe(first.id);
      }
    }).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('rejects malformed coordinates, tags, way references, and relation members', async () => {
    const invalid: readonly OsmDecodedElement[] = [
      { type: 'node', id: 1, version: 1, timestamp: AT, latitude: 999, longitude: 0, tags: {} },
      {
        type: 'node',
        id: 2,
        version: 1,
        timestamp: AT,
        latitude: 37.394,
        longitude: -122.076,
        tags: { foot: 1 },
      },
      {
        type: 'way',
        id: 3,
        version: 1,
        timestamp: AT,
        nodeRefs: [1],
        tags: { highway: 'footway' },
      },
      {
        type: 'relation',
        id: 4,
        version: 1,
        timestamp: AT,
        members: [{ type: 'way', ref: 'bad', role: 'from' }],
        tags: { type: 'restriction' },
      },
    ];
    const decoder = new FixtureDecoder(invalid);
    const instance = adapter(decoder);
    const { artifact } = await acquireFixture(instance);
    const codes: string[] = [];
    for await (const decoded of instance.decode(artifact, phaseContext())) {
      const outcome = await instance.validate(decoded, phaseContext());
      expect(outcome.status).toBe('rejected');
      codes.push(...outcome.issues.map(({ code }) => code));
    }
    expect(codes).toEqual(
      expect.arrayContaining([
        'INVALID_OSM_COORDINATE',
        'MALFORMED_OSM_TAGS',
        'INVALID_OSM_WAY_NODES',
        'INVALID_OSM_RELATION_MEMBERS',
      ]),
    );
  });

  it('preserves access, direction, barriers, crossings, levels, entrances, and disconnection', async () => {
    const { records } = await validatedOfficialRecords();
    const base = records[0];
    if (base === undefined) throw new Error('missing base record');
    const synthetic: readonly ValidatedOsmPedestrianRecord[] = [
      syntheticRecord(
        base,
        {
          type: 'node',
          id: '1',
          version: 1,
          timestamp: AT,
          latitude: 37.394,
          longitude: -122.076,
          tags: { entrance: 'main', level: '0;1' },
        },
        100,
      ),
      syntheticRecord(
        base,
        {
          type: 'node',
          id: '2',
          version: 1,
          timestamp: AT,
          latitude: 37.3941,
          longitude: -122.0761,
          tags: {},
        },
        101,
      ),
      syntheticRecord(
        base,
        {
          type: 'node',
          id: '3',
          version: 1,
          timestamp: AT,
          latitude: 37.3942,
          longitude: -122.0762,
          tags: { barrier: 'wall' },
        },
        102,
      ),
      syntheticRecord(
        base,
        {
          type: 'node',
          id: '4',
          version: 1,
          timestamp: AT,
          latitude: 37.3943,
          longitude: -122.0763,
          tags: {},
        },
        103,
      ),
      syntheticRecord(
        base,
        {
          type: 'node',
          id: '5',
          version: 1,
          timestamp: AT,
          latitude: 37.3944,
          longitude: -122.0764,
          tags: {},
        },
        104,
      ),
      syntheticRecord(
        base,
        {
          type: 'way',
          id: '10',
          version: 1,
          timestamp: AT,
          nodeRefs: ['1', '2'],
          tags: { highway: 'footway', 'oneway:foot': 'yes', level: '1' },
        },
        105,
      ),
      syntheticRecord(
        base,
        {
          type: 'way',
          id: '11',
          version: 1,
          timestamp: AT,
          nodeRefs: ['2', '3'],
          tags: { highway: 'footway', foot: 'no' },
        },
        106,
      ),
      syntheticRecord(
        base,
        {
          type: 'way',
          id: '12',
          version: 1,
          timestamp: AT,
          nodeRefs: ['4', '5'],
          tags: { highway: 'service' },
        },
        107,
      ),
      syntheticRecord(
        base,
        {
          type: 'way',
          id: '13',
          version: 1,
          timestamp: AT,
          nodeRefs: ['4', '5'],
          tags: { foot: 'yes' },
        },
        108,
      ),
      syntheticRecord(
        base,
        {
          type: 'way',
          id: '14',
          version: 1,
          timestamp: AT,
          nodeRefs: ['4', '5'],
          tags: { highway: 'motorway', foot: 'designated' },
        },
        109,
      ),
      syntheticRecord(
        base,
        {
          type: 'relation',
          id: '20',
          version: 1,
          timestamp: AT,
          members: [
            { type: 'way', ref: '10', role: 'from' },
            { type: 'node', ref: '2', role: 'via' },
            { type: 'way', ref: '11', role: 'to' },
          ],
          tags: { type: 'restriction', 'restriction:foot': 'no_left_turn' },
        },
        110,
      ),
    ];
    const graph = normalizeOsmPedestrianGraph({
      records: [...records, ...synthetic],
      extract: TEST_EXTRACT,
      attribution: OSM_ATTRIBUTION,
      notice: OSM_NOTICE,
    });

    expect(graph.nodes.find(({ osmNodeId }) => osmNodeId === '1')).toMatchObject({
      entrance: 'main',
      levels: ['0', '1'],
    });
    expect(graph.nodes.some(({ crossing }) => crossing === 'uncontrolled')).toBe(true);
    expect(
      graph.nodes.some(
        ({ barrier, barrierAccess }) => barrier === 'gate' && barrierAccess === 'allowed',
      ),
    ).toBe(true);
    expect(graph.edges.filter(({ osmWayId }) => osmWayId === '10')).toEqual([
      expect.objectContaining({ direction: 'forward', routable: true, levels: ['1'] }),
    ]);
    expect(
      graph.edges
        .filter(({ osmWayId }) => osmWayId === '11')
        .every(
          (edge) => !edge.routable && edge.exclusionReasons.includes('pedestrian_access_forbidden'),
        ),
    ).toBe(true);
    expect(
      graph.edges
        .filter(({ osmWayId }) => osmWayId === '12')
        .every(
          (edge) => !edge.routable && edge.exclusionReasons.includes('pedestrian_access_unknown'),
        ),
    ).toBe(true);
    for (const osmWayId of ['13', '14']) {
      const unsupportedEdges = graph.edges.filter((edge) => edge.osmWayId === osmWayId);
      expect(unsupportedEdges).toHaveLength(2);
      expect(
        unsupportedEdges.every(
          (edge) =>
            edge.pedestrianAccess === 'allowed' &&
            !edge.routable &&
            edge.exclusionReasons.includes('missing_or_unsupported_highway'),
        ),
      ).toBe(true);
    }
    expect(graph.turnRestrictions).toEqual([
      expect.objectContaining({ restriction: 'no_left_turn', pedestrianAccess: 'forbidden' }),
    ]);
    expect(graph.components.length).toBeGreaterThan(1);
    expect(JSON.stringify(graph)).not.toMatch(/distanceMeters|walkingDistance/u);
    expect(graph.limitations.join(' ')).toContain('straight-line');
  });

  it('orders stable IDs deterministically and rejects conflicting graph duplicates', async () => {
    const { records } = await validatedOfficialRecords();
    const forward = normalizeOsmPedestrianGraph({
      records,
      extract: TEST_EXTRACT,
      attribution: OSM_ATTRIBUTION,
      notice: OSM_NOTICE,
    });
    const reverse = normalizeOsmPedestrianGraph({
      records: [...records].reverse(),
      extract: TEST_EXTRACT,
      attribution: OSM_ATTRIBUTION,
      notice: OSM_NOTICE,
    });
    expect(reverse).toEqual(forward);
    expect(forward.nodes.map(({ osmNodeId }) => BigInt(osmNodeId))).toEqual(
      [...forward.nodes.map(({ osmNodeId }) => BigInt(osmNodeId))].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
    expect(forward.edges.map(({ id }) => id)).toEqual(
      [...forward.edges.map(({ id }) => id)].sort(),
    );

    const duplicate = records[0];
    if (duplicate === undefined) throw new Error('missing duplicate record');
    const exact = normalizeOsmPedestrianGraph({
      records: [...records, duplicate],
      extract: TEST_EXTRACT,
      attribution: OSM_ATTRIBUTION,
      notice: OSM_NOTICE,
    });
    expect(exact.exclusions).toContainEqual(
      expect.objectContaining({ reason: 'duplicate_identical_element' }),
    );
    const conflicting = syntheticRecord(
      duplicate,
      { ...duplicate.element, version: duplicate.element.version + 1 },
      999,
    );
    expect(() =>
      normalizeOsmPedestrianGraph({
        records: [...records, conflicting],
        extract: TEST_EXTRACT,
        attribution: OSM_ATTRIBUTION,
        notice: OSM_NOTICE,
      }),
    ).toThrow(/Conflicting duplicate/u);
  });

  it('emits deterministic phase mutations and a lineage-rich canonical graph reference', async () => {
    const { instance, records } = await validatedOfficialRecords();
    const first = records[0];
    if (first === undefined) throw new Error('missing record');
    const phaseMutations = [];
    for await (const mutation of instance.normalize(first, phaseContext())) {
      phaseMutations.push(canonicalMutationSchema.parse(mutation));
    }
    const again = [];
    for await (const mutation of instance.normalize(first, phaseContext())) again.push(mutation);
    expect(again).toEqual(phaseMutations);
    expect(phaseMutations[0]).toMatchObject({
      kind: 'artifact_reference',
      visibility: 'public',
      artifact: { artifactId: ARTIFACT_ID, role: 'raw' },
    });

    const graph = normalizeOsmPedestrianGraph({
      records,
      extract: TEST_EXTRACT,
      attribution: OSM_ATTRIBUTION,
      notice: OSM_NOTICE,
    });
    const reference = createPedestrianGraphReferenceMutation({
      graph,
      runId: RUN_ID,
      emittedAt: AT,
      sequence: 0,
    });
    expect(reference).toMatchObject({
      kind: 'entity_upsert',
      visibility: 'public',
      entity: {
        entityKind: 'pedestrian-graph-ref',
        artifactId: ARTIFACT_ID,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        routingProfileVersion: '1.0.0',
      },
    });
    expect(
      reference.kind === 'entity_upsert' ? reference.entity.lineage[0]?.sourceRecord : null,
    ).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      artifactId: ARTIFACT_ID,
      recordSha256: PBF_SHA256,
    });
    expect(
      createPedestrianGraphReferenceMutation({ graph, runId: RUN_ID, emittedAt: AT, sequence: 0 }),
    ).toEqual(reference);
  });

  it('reconciles summary accounting and visibility', async () => {
    const { instance, artifact, records } = await validatedOfficialRecords();
    const plan = await planFor(instance);
    const mutations = [];
    const first = records[0];
    if (first === undefined) throw new Error('missing summary record');
    for await (const mutation of instance.normalize(first, phaseContext()))
      mutations.push(mutation);
    const checkpoint: SourceCheckpoint = sourceCheckpointSchema.parse({
      sourceId: OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
      snapshotId: SNAPSHOT_ID,
      contractVersion: '1.0.0',
      cursor: 'sequence:1',
      nextSequence: 1,
      completedRequestKeys: [TEST_EXTRACT.extractId],
      acquiredArtifactIds: [ARTIFACT_ID],
      updatedAt: AT,
      complete: true,
    });
    const run: SourceRunObservation = {
      descriptor: instance.describe(),
      runId: RUN_ID,
      request: request(),
      plan,
      startedAt: AT,
      completedAt: AT,
      finalCheckpoint: checkpoint,
      artifacts: [artifact.metadata],
      decodedRecords: records.length,
      acceptedRecords: records.length,
      rejectedRecords: 0,
      mutations,
      validationIssues: [],
      aborted: false,
    };
    expect(instance.summarize(run, phaseContext())).toMatchObject({
      status: 'succeeded',
      artifactsAcquired: 1,
      bytesAcquired: PBF_TRANSPORT_SENTINEL.byteLength,
      decodedRecords: 18,
      acceptedRecords: 18,
      rejectedRecords: 0,
      visibilityCounts: { public: 1 },
    });
    expect(() => instance.summarize({ ...run, decodedRecords: 17 }, phaseContext())).toThrow();
  });
});
