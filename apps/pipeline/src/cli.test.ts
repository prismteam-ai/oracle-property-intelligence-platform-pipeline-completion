import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, parsePublicClosureArguments } from './cli.js';

const VALID_ARGUMENTS = Object.freeze([
  'public-closure',
  '--run-root',
  'run-root',
  '--run-manifest',
  'terminal.json',
  '--authorization-policy',
  'authorization.json',
  '--private-key-file',
  'authorization.pem',
  '--output',
  'public-output',
]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('public-closure CLI parser', () => {
  it('parses each required option exactly once in any order', () => {
    expect(parsePublicClosureArguments(VALID_ARGUMENTS)).toEqual({
      runRoot: 'run-root',
      runManifestPath: 'terminal.json',
      authorizationPolicyPath: 'authorization.json',
      privateKeyPath: 'authorization.pem',
      outputDirectory: 'public-output',
    });
    expect(
      parsePublicClosureArguments([
        'public-closure',
        '--output',
        'public-output',
        '--private-key-file',
        'authorization.pem',
        '--authorization-policy',
        'authorization.json',
        '--run-manifest',
        'terminal.json',
        '--run-root',
        'run-root',
      ]),
    ).toEqual(parsePublicClosureArguments(VALID_ARGUMENTS));
  });

  it.each([
    ['missing value', [...VALID_ARGUMENTS.slice(0, -1)]],
    [
      'flag-shaped value',
      VALID_ARGUMENTS.map((value, index) => (index === 2 ? '--run-manifest' : value)),
    ],
    ['duplicate flag', VALID_ARGUMENTS.map((value, index) => (index === 9 ? '--run-root' : value))],
    ['unknown flag', VALID_ARGUMENTS.map((value, index) => (index === 9 ? '--unknown' : value))],
    ['extra positional argument', [...VALID_ARGUMENTS, 'extra']],
  ])('returns usage code 2 for a %s', async (_label, arguments_) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(main(arguments_)).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr.mock.calls[0]?.[0]).toContain('Usage: oracle-pipeline');
  });
});
