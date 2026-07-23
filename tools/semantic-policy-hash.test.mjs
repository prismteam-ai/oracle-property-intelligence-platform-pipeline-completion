import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { computeSemanticPolicyHash } from './semantic-policy-hash.mjs';

const fixture = (name) =>
  fileURLToPath(new URL(`./fixtures/semantic-policy-hash/${name}`, import.meta.url));

// These are GOLDEN values. The hash they pin is deployed as a CDK context value,
// so a silent change here means the deployed policy identity no longer matches
// what the running agent computes. If a change to the named-evidence tool
// schemas, the support-state vocabulary, the data dictionary, the prompt policy,
// or the capability-gating logic is genuinely intended, update these constants
// IN THE SAME COMMIT and redeploy — do not "fix the test" in isolation.
const ALL_SUPPORTED_HASH =
  'sha256:fad7845ce022791e470ca2694b5f919aa82a0d98b2e16630f1935e39850dbf29';
const MIXED_HASH = 'sha256:2856c82c8fc12ab30896d9ceca1d98db2e4694b88a3740ce5e9f0063c9546fa5';

describe('computeSemanticPolicyHash', () => {
  it('pins the hash for an all-supported capability set', async () => {
    await expect(computeSemanticPolicyHash(fixture('all-supported.serving-config.json'))).resolves.toBe(
      ALL_SUPPORTED_HASH,
    );
  });

  it('pins the hash for a mixed blocked/partial/supported capability set', async () => {
    await expect(computeSemanticPolicyHash(fixture('mixed.serving-config.json'))).resolves.toBe(
      MIXED_HASH,
    );
  });

  it('produces a distinct hash per capability set, so gating actually feeds the hash', () => {
    expect(ALL_SUPPORTED_HASH).not.toBe(MIXED_HASH);
  });

  it('is deterministic across repeated invocations', async () => {
    const path = fixture('mixed.serving-config.json');
    const [first, second] = await Promise.all([
      computeSemanticPolicyHash(path),
      computeSemanticPolicyHash(path),
    ]);
    expect(first).toBe(second);
  });

  it('emits a sha256 hash in the documented shape', async () => {
    await expect(computeSemanticPolicyHash(fixture('mixed.serving-config.json'))).resolves.toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  it('fails loudly when the path is missing', async () => {
    await expect(computeSemanticPolicyHash('')).rejects.toThrow(
      /serving-config\.json path is required/u,
    );
  });

  it('fails loudly when the file does not exist', async () => {
    await expect(
      computeSemanticPolicyHash(fixture('does-not-exist.serving-config.json')),
    ).rejects.toThrow(/Cannot read serving config/u);
  });

  it('fails loudly when the file is not valid JSON', async () => {
    await expect(computeSemanticPolicyHash(fixture('malformed.serving-config.json'))).rejects.toThrow(
      /is not valid JSON/u,
    );
  });

  it('fails loudly when the config has no capabilities object', async () => {
    await expect(
      computeSemanticPolicyHash(fixture('no-capabilities.serving-config.json')),
    ).rejects.toThrow(/no usable "capabilities" object/u);
  });
});
