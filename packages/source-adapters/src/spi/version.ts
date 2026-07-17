import { semverSchema } from '@oracle/contracts/foundation';

declare const sourceAdapterContractVersionBrand: unique symbol;

export type SourceAdapterContractVersion = string & {
  readonly [sourceAdapterContractVersionBrand]: true;
};

export const SOURCE_ADAPTER_CONTRACT_VERSION = '1.0.0' as SourceAdapterContractVersion;

export function parseSourceAdapterContractVersion(value: string): SourceAdapterContractVersion {
  if (!semverSchema.safeParse(value).success) {
    throw new TypeError(`Invalid source adapter contract version: ${value}`);
  }

  return value as SourceAdapterContractVersion;
}
