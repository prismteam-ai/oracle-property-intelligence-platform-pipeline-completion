import type { FieldLineage } from '@oracle/contracts/canonical/lineage';
import type { ArtifactId, SnapshotId } from '@oracle/contracts/ids';
import type { Visibility } from '@oracle/contracts/visibility';
import type { GeoJsonDecodedRecord, JsonValue } from '../../spi/decode.js';

export interface OvertureNameRule {
  readonly variant: string;
  readonly language: string | null;
  readonly value: string;
}

export interface OvertureNames {
  readonly primary: string;
  readonly common: Readonly<Record<string, string>>;
  readonly rules: readonly OvertureNameRule[];
}

export interface OvertureCategories {
  readonly primary: string;
  readonly alternate: readonly string[];
}

export interface OvertureBrand {
  readonly wikidata: string | null;
  readonly names: OvertureNames | null;
}

export interface OvertureAddress {
  readonly freeform: string;
  readonly locality: string | null;
  readonly postcode: string | null;
  readonly region: string | null;
  readonly country: string | null;
}

export interface OvertureContributor {
  readonly property: string;
  readonly dataset: string;
  readonly license: string;
  readonly recordId: string | null;
  readonly updateTime: string;
  readonly confidence: number | null;
}

export type BrandMatchMode =
  | 'wikidata_exact'
  | 'brand_name_exact'
  | 'primary_name_exact'
  | 'category_name_combination'
  | 'no_match';

export interface StarbucksMatchEvidence {
  readonly mode: BrandMatchMode;
  readonly wikidataMatched: boolean;
  readonly brandNameMatched: boolean;
  readonly primaryNameMatched: boolean;
  readonly coffeeCategoryMatched: boolean;
  readonly matchedValues: readonly string[];
}

export type ManualLocatorValidation =
  | Readonly<{
      state: 'not_sampled';
      checkedAt: null;
      sampledManually: false;
      note: 'No official Starbucks-locator validation has been performed';
    }>
  | Readonly<{
      state: 'sampled_open' | 'sampled_closed' | 'sampled_conflict' | 'sampled_unknown';
      checkedAt: string;
      sampledManually: true;
      note: string;
    }>;

export interface OvertureDecodedPlace extends GeoJsonDecodedRecord {
  readonly release: string;
  readonly theme: string;
  readonly overtureType: 'place';
  readonly gersId: string;
  readonly version: number;
  readonly retrievedAt: string;
  readonly rawFeatureSha256: string;
}

export interface OvertureStarbucksCandidate {
  readonly artifactId: ArtifactId;
  readonly snapshotId: SnapshotId;
  readonly ordinal: number;
  readonly visibility: Visibility;
  readonly release: string;
  readonly theme: 'places';
  readonly featureType: 'place';
  readonly gersId: string;
  readonly version: number;
  readonly geometry: Readonly<{ type: 'Point'; coordinates: readonly [number, number] }>;
  readonly names: OvertureNames;
  readonly categories: OvertureCategories;
  readonly brand: OvertureBrand | null;
  readonly confidence: number;
  readonly overtureOperatingStatus: 'open' | 'closed' | 'unknown';
  readonly addresses: readonly OvertureAddress[];
  readonly contributors: readonly OvertureContributor[];
  readonly sourceLicenses: readonly string[];
  readonly sourceNotices: readonly string[];
  readonly updateTime: string;
  readonly matchEvidence: StarbucksMatchEvidence;
  readonly validation: ManualLocatorValidation;
  readonly candidateState:
    'candidate' | 'low_confidence_candidate' | 'closed_candidate' | 'not_starbucks_candidate';
  readonly artifactRetrievedAt: string;
  readonly rawFeatureSha256: string;
  readonly lineage: FieldLineage;
}

export interface OvertureFixtureFeature {
  readonly type: 'Feature';
  readonly id: string;
  readonly geometry: Readonly<{ type: 'Point'; coordinates: readonly [number, number] }>;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface OvertureArtifactConfig {
  readonly url: string;
  readonly encoding: 'parquet' | 'geojson';
  readonly mediaTypes: readonly string[];
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly expectedEtag: string | null;
  readonly expectedLastModified: string;
}

export interface OvertureAdapterOptions {
  readonly artifact?: OvertureArtifactConfig;
  readonly maximumRows?: number;
  readonly minimumCandidateConfidence?: number;
}
