export {
  createSantaClaraSocrataParcelsAdapter,
  SantaClaraSocrataParcelsAdapter,
} from './adapter.js';
export {
  SANTA_CLARA_PARCELS_API_ROOT,
  SANTA_CLARA_PARCELS_COUNT_URLS,
  SANTA_CLARA_PARCELS_CRS,
  SANTA_CLARA_PARCELS_DATASET_ID,
  SANTA_CLARA_PARCELS_DESCRIPTOR,
  SANTA_CLARA_PARCELS_METADATA_URL,
  SANTA_CLARA_PARCELS_SCHEMA_COLUMNS,
  SANTA_CLARA_PARCELS_SCHEMA_FINGERPRINT,
  SANTA_CLARA_PARCELS_SOURCE_ID,
} from './constants.js';
export { normalizeSantaClaraParcelApn } from './records.js';
export type { SantaClaraParcelDecodedRecord, SantaClaraParcelValidatedRecord } from './records.js';
