import { isoDateTimeSchema } from '@oracle/contracts/foundation';

import type { ManualLocatorValidation, OvertureStarbucksCandidate } from './types.js';

export const NOT_SAMPLED_VALIDATION: ManualLocatorValidation = Object.freeze({
  state: 'not_sampled',
  checkedAt: null,
  sampledManually: false,
  note: 'No official Starbucks-locator validation has been performed',
});

export function applyManualLocatorValidation(
  candidate: OvertureStarbucksCandidate,
  evidence: Readonly<{
    gersId: string;
    state: Exclude<ManualLocatorValidation['state'], 'not_sampled'>;
    checkedAt: string;
    note: string;
    sampledManually: true;
  }>,
): OvertureStarbucksCandidate {
  if (evidence.gersId !== candidate.gersId) {
    throw new TypeError('Manual locator evidence GERS ID does not match the candidate');
  }
  const checkedAt = isoDateTimeSchema.parse(evidence.checkedAt);
  const note = evidence.note.trim();
  if (note.length < 8 || /https?:\/\//iu.test(note)) {
    throw new TypeError(
      'Persist only a concise manual outcome note, never locator content or URLs',
    );
  }
  return Object.freeze({
    ...candidate,
    validation: Object.freeze({
      state: evidence.state,
      checkedAt,
      sampledManually: true,
      note,
    }),
  });
}
