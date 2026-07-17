export {
  createSantaClaraOwnershipTransferCapabilityAdapter,
  OWNERSHIP_CAPABILITY_ACCEPT_HEADER_SHA256,
  SANTA_CLARA_OWNERSHIP_TRANSFER_DESCRIPTOR,
  SantaClaraOwnershipTransferCapabilityAdapter,
} from './adapter.js';
export {
  assessNoRecordedExchange,
  createOwnershipTransferCapability,
  deduplicateOwnershipIndexRows,
  projectOwnershipRows,
  validateOwnershipIndexRow,
} from './capability.js';
export {
  OWNERSHIP_CAPABILITY_CAPTURED_AT,
  OWNERSHIP_CAPABILITY_PAGE_SPECS,
  OWNERSHIP_CAPABILITY_SCHEMA_FINGERPRINT,
  OWNERSHIP_CAPABILITY_SCHEMA_VERSION,
  OWNERSHIP_DATA_SALES_URL,
  OWNERSHIP_FEE_SCHEDULE_URL,
  OWNERSHIP_RESEARCH_URL,
  OWNERSHIP_TRANSFER_LICENSE_SNAPSHOT_ID,
  OWNERSHIP_TRANSFER_SOURCE_ID,
} from './constants.js';
export type {
  OwnershipCapabilityPageEvidence,
  OwnershipCapabilitySupportState,
  OwnershipExchangeEvidenceResult,
  OwnershipIndexRow,
  OwnershipIndexValidation,
  OwnershipTransferCapability,
} from './types.js';
