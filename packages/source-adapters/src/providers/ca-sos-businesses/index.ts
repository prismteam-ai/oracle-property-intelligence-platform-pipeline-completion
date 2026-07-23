export {
  CA_SOS_BUSINESS_DESCRIPTOR,
  CA_SOS_BUSINESS_LICENSE_ID,
  CA_SOS_BUSINESS_SOURCE_ID,
  CA_SOS_CONTRACT_VERSION,
  CA_SOS_INTERCHANGE_HEADER,
  CA_SOS_SCHEMA_FINGERPRINT,
  CA_SOS_TRANSFORM_VERSION,
} from './constants.js';
export { createCaSosBusinessAdapter } from './adapter.js';
export type {
  CaSosBusinessAdapterOptions,
  CaSosBusinessSourceLock,
  CaSosDecodedBusinessRecord,
  CaSosEntityNumberKind,
  CaSosInterchangeColumn,
  CaSosValidatedBusinessRecord,
} from './types.js';
