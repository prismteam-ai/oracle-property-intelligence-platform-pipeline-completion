import { featureEvidenceSchema, type FeatureEvidence } from '@oracle/contracts/evidence';

type FeatureEvidenceReference = FeatureEvidence['sourceReferences'][number];

export type ImmutableFeatureEvidence = Readonly<
  Omit<FeatureEvidence, 'sourceReferences' | 'algorithm' | 'limitations'> & {
    sourceReferences: readonly Readonly<
      Omit<FeatureEvidenceReference, 'fieldPaths'> & { fieldPaths: readonly string[] }
    >[];
    algorithm: Readonly<
      Omit<FeatureEvidence['algorithm'], 'parameters'> & {
        parameters: Readonly<FeatureEvidence['algorithm']['parameters']>;
      }
    >;
    limitations: readonly string[];
  }
>;

function referenceKey(
  reference: Pick<FeatureEvidenceReference, 'sourceId' | 'snapshotId' | 'artifactId' | 'recordKey'>,
): string {
  return [reference.sourceId, reference.snapshotId, reference.artifactId, reference.recordKey].join(
    '\0',
  );
}

export function createFeatureEvidence(input: unknown): ImmutableFeatureEvidence {
  const parsed = featureEvidenceSchema.parse(input);
  const referenceKeys = parsed.sourceReferences.map(referenceKey);
  if (new Set(referenceKeys).size !== referenceKeys.length) {
    throw new Error('Feature evidence source references must be unique');
  }
  if (new Set(parsed.limitations).size !== parsed.limitations.length) {
    throw new Error('Feature evidence limitations must be unique');
  }

  const sourceReferences = parsed.sourceReferences
    .map((reference) =>
      Object.freeze({
        ...reference,
        fieldPaths: Object.freeze([...reference.fieldPaths].sort()),
      }),
    )
    .sort((left, right) => {
      const leftKey = referenceKey(left);
      const rightKey = referenceKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const parameters = Object.fromEntries(
    Object.entries(parsed.algorithm.parameters).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );

  return Object.freeze({
    ...parsed,
    sourceReferences: Object.freeze(sourceReferences),
    algorithm: Object.freeze({
      ...parsed.algorithm,
      parameters: Object.freeze(parameters),
    }),
    limitations: Object.freeze([...parsed.limitations].sort()),
  });
}
