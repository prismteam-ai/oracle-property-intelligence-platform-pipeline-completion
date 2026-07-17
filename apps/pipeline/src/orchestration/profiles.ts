import type { RunProfile, RunProfileName } from './types.js';

export function createRunProfile(
  name: RunProfileName,
  options: Readonly<{
    recordCap?: number | null;
    maxConcurrentSources?: number;
    maxBufferedRecords?: number;
  }> = {},
): RunProfile {
  const maxConcurrentSources = options.maxConcurrentSources ?? 1;
  const maxBufferedRecords = options.maxBufferedRecords ?? 1_000;
  if (!Number.isSafeInteger(maxConcurrentSources) || maxConcurrentSources < 1) {
    throw new RangeError('maxConcurrentSources must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxBufferedRecords) || maxBufferedRecords < 1) {
    throw new RangeError('maxBufferedRecords must be a positive safe integer');
  }

  const suppliedCap = options.recordCap;
  if (name === 'full' && suppliedCap !== undefined && suppliedCap !== null) {
    throw new TypeError('The full profile is uncapped; recordCap must be null');
  }
  const recordCap = name === 'pilot' ? (suppliedCap ?? 50) : (suppliedCap ?? null);
  if (name === 'pilot' && (!Number.isSafeInteger(recordCap) || (recordCap ?? 0) < 1)) {
    throw new RangeError('The pilot profile requires a positive recordCap');
  }
  if (name !== 'pilot' && recordCap !== null) {
    throw new TypeError(`${name} profile cannot carry a record cap`);
  }

  return Object.freeze({ name, recordCap, maxConcurrentSources, maxBufferedRecords });
}

export function acquisitionModeFor(profile: RunProfileName): 'full' | 'incremental' {
  return profile === 'incremental' ? 'incremental' : 'full';
}
