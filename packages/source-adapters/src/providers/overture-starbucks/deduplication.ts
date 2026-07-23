import type { OvertureStarbucksCandidate } from './types.js';

export type DuplicateDecisionReason =
  | 'same_gers_id'
  | 'spatial_and_address_match'
  | 'conflicting_same_gers_id'
  | 'name_only_insufficient'
  | 'distinct';

export interface DuplicateDecision {
  readonly leftGersId: string;
  readonly rightGersId: string;
  readonly duplicate: boolean;
  readonly reason: DuplicateDecisionReason;
  readonly distanceMeters: number;
  readonly normalizedAddressMatched: boolean;
}

export interface DeduplicationResult {
  readonly candidates: readonly OvertureStarbucksCandidate[];
  readonly decisions: readonly DuplicateDecision[];
}

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

function distanceMeters(
  left: OvertureStarbucksCandidate,
  right: OvertureStarbucksCandidate,
): number {
  const [leftLongitude, leftLatitude] = left.geometry.coordinates;
  const [rightLongitude, rightLatitude] = right.geometry.coordinates;
  const latitudeDelta = radians(rightLatitude - leftLatitude);
  const longitudeDelta = radians(rightLongitude - leftLongitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(leftLatitude)) *
      Math.cos(radians(rightLatitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizedAddress(candidate: OvertureStarbucksCandidate): string | null {
  const first = candidate.addresses[0];
  if (first === undefined) return null;
  return [first.freeform, first.locality ?? '', first.region ?? '', first.postcode ?? '']
    .join('|')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9|]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function sameMaterialIdentity(
  left: OvertureStarbucksCandidate,
  right: OvertureStarbucksCandidate,
  distance: number,
  addressMatched: boolean,
): boolean {
  return distance <= 15 && addressMatched;
}

function prefer(
  left: OvertureStarbucksCandidate,
  right: OvertureStarbucksCandidate,
): OvertureStarbucksCandidate {
  if (left.version !== right.version) return left.version > right.version ? left : right;
  if (left.confidence !== right.confidence)
    return left.confidence > right.confidence ? left : right;
  return left.gersId <= right.gersId ? left : right;
}

export function deduplicateStarbucksCandidates(
  input: readonly OvertureStarbucksCandidate[],
): DeduplicationResult {
  const ordered = [...input].sort((left, right) =>
    left.gersId === right.gersId
      ? left.rawFeatureSha256.localeCompare(right.rawFeatureSha256)
      : left.gersId.localeCompare(right.gersId),
  );
  const kept: OvertureStarbucksCandidate[] = [];
  const decisions: DuplicateDecision[] = [];
  for (const candidate of ordered) {
    let duplicateIndex = -1;
    for (const [index, existing] of kept.entries()) {
      const distance = distanceMeters(existing, candidate);
      const leftAddress = normalizedAddress(existing);
      const addressMatched = leftAddress !== null && leftAddress === normalizedAddress(candidate);
      const sameGers = existing.gersId === candidate.gersId;
      const spatialAddress = sameMaterialIdentity(existing, candidate, distance, addressMatched);
      const sameName =
        existing.names.primary.localeCompare(candidate.names.primary, undefined, {
          sensitivity: 'base',
        }) === 0;
      const duplicate = sameGers ? spatialAddress : spatialAddress;
      const reason: DuplicateDecisionReason = sameGers
        ? spatialAddress
          ? 'same_gers_id'
          : 'conflicting_same_gers_id'
        : spatialAddress
          ? 'spatial_and_address_match'
          : sameName
            ? 'name_only_insufficient'
            : 'distinct';
      decisions.push(
        Object.freeze({
          leftGersId: existing.gersId,
          rightGersId: candidate.gersId,
          duplicate,
          reason,
          distanceMeters: distance,
          normalizedAddressMatched: addressMatched,
        }),
      );
      if (duplicate) {
        duplicateIndex = index;
        kept[index] = prefer(existing, candidate);
        break;
      }
    }
    if (duplicateIndex === -1) kept.push(candidate);
  }
  return Object.freeze({
    candidates: Object.freeze(kept),
    decisions: Object.freeze(decisions),
  });
}
