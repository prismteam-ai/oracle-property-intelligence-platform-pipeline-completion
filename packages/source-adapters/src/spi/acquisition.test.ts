import type {
  RecoverableArtifactStore,
  StreamingImmutableArtifactWrite,
} from '@oracle/artifacts/artifact-store';
import { describe, expect, it } from 'vitest';

import { AcquisitionByteLimitError, persistAcquiredBody } from './acquisition.js';

describe('bounded acquisition stream', () => {
  it('passes response chunks directly to the store and enforces maximum bytes', async () => {
    let request: StreamingImmutableArtifactWrite | undefined;
    const store = {
      putImmutableStreaming: async (value: StreamingImmutableArtifactWrite) => {
        request = value;
        let byteSize = 0;
        for await (const chunk of value.body as AsyncIterable<Uint8Array>) byteSize += chunk.length;
        return {
          logicalKey: value.logicalKey,
          uri: 'file:///raw/body',
          mediaType: value.mediaType,
          byteSize,
          sha256: '0'.repeat(64),
          storedAt: '2026-07-18T00:00:00.000Z',
          metadata: value.metadata,
        };
      },
    } as RecoverableArtifactStore;
    const controller = new AbortController();
    const body = async function* () {
      yield await Promise.resolve(new Uint8Array([1, 2]));
      yield await Promise.resolve(new Uint8Array([3]));
    };
    await persistAcquiredBody({
      store,
      logicalKey: 'raw/source',
      mediaType: 'application/octet-stream',
      body: body(),
      maximumBytes: 3,
      metadata: {},
      signal: controller.signal,
    });
    expect(request?.body).not.toBeInstanceOf(Uint8Array);
    await expect(
      persistAcquiredBody({
        store,
        logicalKey: 'raw/too-large',
        mediaType: 'application/octet-stream',
        body: body(),
        maximumBytes: 2,
        metadata: {},
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AcquisitionByteLimitError);
  });
});
