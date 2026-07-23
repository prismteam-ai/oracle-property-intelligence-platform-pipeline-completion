import { sourceDescriptorSchema, type SourceDescriptor } from '@oracle/contracts/source';
import type { SourceId } from '@oracle/contracts/ids';

import {
  parseSourceAdapterContractVersion,
  SOURCE_ADAPTER_CONTRACT_VERSION,
} from './spi/version.js';

export interface SourceAdapterRegistration {
  describe(): SourceDescriptor;
}

interface RegisteredAdapter<TAdapter extends SourceAdapterRegistration> {
  readonly adapter: TAdapter;
  readonly descriptor: SourceDescriptor;
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (typeof nested === 'object' && nested !== null && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

export class DuplicateSourceIdError extends Error {
  public readonly sourceId: SourceId;

  public constructor(sourceId: SourceId) {
    super(`Source adapter already registered: ${sourceId}`);
    this.name = 'DuplicateSourceIdError';
    this.sourceId = sourceId;
  }
}

export class UnsupportedSourceContractVersionError extends Error {
  public readonly contractVersion: string;

  public constructor(contractVersion: string) {
    super(`Unsupported source adapter contract version: ${contractVersion}`);
    this.name = 'UnsupportedSourceContractVersionError';
    this.contractVersion = contractVersion;
  }
}

/**
 * Composition owns registrations. This module intentionally imports no
 * provider so adding a provider lane never changes the registry core.
 */
export class SourceAdapterRegistry<
  TAdapter extends SourceAdapterRegistration = SourceAdapterRegistration,
> {
  readonly #adapters = new Map<SourceId, RegisteredAdapter<TAdapter>>();
  readonly #supportedContractVersions: ReadonlySet<string>;

  public constructor(
    supportedContractVersions: readonly string[] = [SOURCE_ADAPTER_CONTRACT_VERSION],
  ) {
    if (supportedContractVersions.length === 0) {
      throw new TypeError('At least one source adapter contract version is required');
    }
    this.#supportedContractVersions = new Set(
      supportedContractVersions.map((version) => parseSourceAdapterContractVersion(version)),
    );
  }

  public register(adapter: TAdapter): void {
    this.registerAll([adapter]);
  }

  /** Validates the full batch before mutation, making composition atomic. */
  public registerAll(adapters: Iterable<TAdapter>): void {
    const pending = new Map<SourceId, RegisteredAdapter<TAdapter>>();
    for (const adapter of adapters) {
      const descriptor = deepFreeze(sourceDescriptorSchema.parse(adapter.describe()));
      parseSourceAdapterContractVersion(descriptor.contractVersion);
      if (!this.#supportedContractVersions.has(descriptor.contractVersion)) {
        throw new UnsupportedSourceContractVersionError(descriptor.contractVersion);
      }
      if (this.#adapters.has(descriptor.sourceId) || pending.has(descriptor.sourceId)) {
        throw new DuplicateSourceIdError(descriptor.sourceId);
      }
      pending.set(descriptor.sourceId, Object.freeze({ adapter, descriptor }));
    }

    for (const [sourceId, registration] of pending) {
      this.#adapters.set(sourceId, registration);
    }
  }

  public get(sourceId: SourceId): TAdapter | undefined {
    return this.#adapters.get(sourceId)?.adapter;
  }

  public require(sourceId: SourceId): TAdapter {
    const adapter = this.get(sourceId);
    if (adapter === undefined) {
      throw new Error(`Source adapter is not registered: ${sourceId}`);
    }
    return adapter;
  }

  public descriptors(): readonly SourceDescriptor[] {
    return Object.freeze(
      [...this.#adapters.values()]
        .map(({ descriptor }) => descriptor)
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    );
  }
}
