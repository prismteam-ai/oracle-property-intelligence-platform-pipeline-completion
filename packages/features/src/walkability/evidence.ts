import type { SourceObservation, Visibility } from './types.js';

const VISIBILITY_ORDER: Readonly<Record<Visibility, number>> = Object.freeze({
  public: 0,
  authenticated: 1,
  restricted: 2,
  prohibited_public: 3,
});

export function mostRestrictiveVisibility(values: readonly Visibility[]): Visibility {
  return values.reduce<Visibility>(
    (selected, value) => (VISIBILITY_ORDER[value] > VISIBILITY_ORDER[selected] ? value : selected),
    'public',
  );
}

export function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

export function countReasons(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.freeze(
    Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  );
}

export function sortObservations(
  observations: readonly SourceObservation[],
): readonly SourceObservation[] {
  return Object.freeze(
    observations
      .map((observation) =>
        Object.freeze({
          ...observation,
          recordIds: sortedUnique(observation.recordIds),
        }),
      )
      .sort(
        (left, right) =>
          left.sourceId.localeCompare(right.sourceId) ||
          left.snapshotId.localeCompare(right.snapshotId) ||
          left.artifactId.localeCompare(right.artifactId),
      ),
  );
}
