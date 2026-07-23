import { createHash } from 'node:crypto';

import {
  licenseSnapshotIdSchema,
  sourceIdSchema,
  type LicenseSnapshotId,
  type SourceId,
} from '@oracle/contracts/ids';

export const CSLB_CONTRACTOR_SOURCE_ID: SourceId = sourceIdSchema.parse(
  'sc:source:cslb-contractors',
);

export const CSLB_CONTRACTOR_LICENSE_ID: LicenseSnapshotId = licenseSnapshotIdSchema.parse(
  'sc:license:cslb-contractors:f718955f4acc6e41c208b8e85f5f459767c1efc7e3dde0f95dc4b5743c750787',
);

export const CSLB_PORTAL_URL = 'https://web.cslb.ca.gov/onlineservices/dataportal/ContractorList';
export const CSLB_MASTER_REQUEST_KEY = 'license-master-csv';

export const CSLB_MASTER_HEADER = [
  'LicenseNo',
  'LastUpdate',
  'BusinessName',
  'BUS-NAME-2',
  'FullBusinessName',
  'MailingAddress',
  'City',
  'State',
  'County',
  'ZIPCode',
  'country',
  'BusinessPhone',
  'BusinessType',
  'IssueDate',
  'ReissueDate',
  'ExpirationDate',
  'InactivationDate',
  'ReactivationDate',
  'PendingSuspension',
  'PendingClassRemoval',
  'PendingClassReplace',
  'PrimaryStatus',
  'SecondaryStatus',
  'Classifications(s)',
  'AsbestosReg',
  'WorkersCompCoverageType',
  'WCInsuranceCompany',
  'WCPolicyNumber',
  'WCEffectiveDate',
  'WCExpirationDate',
  'WCCancellationDate',
  'WCSuspendDate',
  'CBSuretyCompany',
  'CBNumber',
  'CBEffectiveDate',
  'CBCancellationDate',
  'CBAmount',
  'WBSuretyCompany',
  'WBNumber',
  'WBEffectiveDate',
  'WBCancellationDate',
  'WBAmount',
  'DBSuretyCompany',
  'DBNumber',
  'DBEffectiveDate',
  'DBCancellationDate',
  'DBAmount',
  'DateRequired',
  'DiscpCaseRegion',
  'DBBondReason',
  'DBCaseNo',
  'NAME-TP-2',
] as const;

export type CslbMasterField = (typeof CSLB_MASTER_HEADER)[number];

export const CSLB_MASTER_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(CSLB_MASTER_HEADER.join(','))
  .digest('hex');

export const CSLB_PORTAL_SELECT_EVENT = 'ctl00$MainContent$ddlStatus';
export const CSLB_MASTER_DOWNLOAD_EVENT = 'ctl00$MainContent$lbMasterCSV';
export const CSLB_PORTAL_SELECT_FIELD = 'ctl00$MainContent$ddlStatus';
export const CSLB_MASTER_SELECT_VALUE = 'M';
