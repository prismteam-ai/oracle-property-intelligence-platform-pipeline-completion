import { describe, expect, it } from 'vitest';

import { SOURCE_ADAPTER_CONTRACT_VERSION, parseSourceAdapterContractVersion } from './version.js';

describe('source adapter contract versions', () => {
  it('accepts the frozen semantic version', () => {
    expect(parseSourceAdapterContractVersion(SOURCE_ADAPTER_CONTRACT_VERSION)).toBe('1.0.0');
    expect(parseSourceAdapterContractVersion('0.1.0')).toBe('0.1.0');
  });

  it.each(['v1', '1', '1.0', '1.0.x', '1.0.0-beta'])('rejects %s', (version) => {
    expect(() => parseSourceAdapterContractVersion(version)).toThrow(TypeError);
  });
});
