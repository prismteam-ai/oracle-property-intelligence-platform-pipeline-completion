import {
  namedQueryDefinitionSchema,
  type NamedQueryDefinition,
  type NamedQueryName,
} from '@oracle/contracts/query';
import type {
  AnalyticalParameter,
  AnalyticalRow,
  AnalyticalSession,
} from '@oracle/data-runtime/analytical-runtime';

export type NamedQueryParser<T> = (value: unknown) => T;

export type NamedQueryImplementation<TInput, TRow extends AnalyticalRow> = Readonly<{
  contract: NamedQueryDefinition;
  statement: string;
  parseInput: NamedQueryParser<TInput>;
  parseRow: NamedQueryParser<TRow>;
  parameters: (input: TInput) => readonly AnalyticalParameter[];
}>;

export type NamedQueryExecution<TRow extends AnalyticalRow> = Readonly<{
  name: NamedQueryName;
  contractVersion: string;
  rows: readonly TRow[];
  elapsedMs: number;
  scannedBytes: number | null;
  truncated: boolean;
}>;

type AnyNamedQuery = NamedQueryImplementation<unknown, AnalyticalRow>;

function key(name: NamedQueryName, contractVersion: string): string {
  return `${name}@${contractVersion}`;
}

export class NamedQueryRegistry {
  readonly #definitions = new Map<string, AnyNamedQuery>();

  register<TInput, TRow extends AnalyticalRow>(
    implementation: NamedQueryImplementation<TInput, TRow>,
  ): void {
    const contract = namedQueryDefinitionSchema.parse(implementation.contract);
    if (implementation.statement.trim().length === 0) {
      throw new TypeError('Named query statement must not be empty');
    }
    const registrationKey = key(contract.name, contract.contractVersion);
    if (this.#definitions.has(registrationKey)) {
      throw new Error(`Named query is already registered: ${registrationKey}`);
    }
    this.#definitions.set(
      registrationKey,
      Object.freeze({ ...implementation, contract }) as AnyNamedQuery,
    );
  }

  list(): readonly NamedQueryDefinition[] {
    return Object.freeze(
      [...this.#definitions.values()]
        .map(({ contract }) => contract)
        .sort(
          (left, right) =>
            (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
            (left.contractVersion < right.contractVersion
              ? -1
              : left.contractVersion > right.contractVersion
                ? 1
                : 0),
        ),
    );
  }

  async execute<TRow extends AnalyticalRow>(request: {
    name: NamedQueryName;
    contractVersion: string;
    input: unknown;
    session: AnalyticalSession;
    signal?: AbortSignal;
  }): Promise<NamedQueryExecution<TRow>> {
    const registrationKey = key(request.name, request.contractVersion);
    const implementation = this.#definitions.get(registrationKey) as
      NamedQueryImplementation<unknown, TRow> | undefined;
    if (implementation === undefined) {
      throw new Error(`Unknown named query: ${registrationKey}`);
    }
    const input = implementation.parseInput(request.input);
    const { contract } = implementation;
    const result = await request.session.execute<TRow>({
      operation: registrationKey,
      statement: implementation.statement,
      parameters: implementation.parameters(input),
      timeoutMs: contract.timeoutMs,
      maximumScanBytes: contract.maximumScanBytes,
      maximumRows: contract.maximumResults,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (result.scannedBytes !== null && result.scannedBytes > contract.maximumScanBytes) {
      throw new RangeError(`Named query exceeded its scan budget: ${registrationKey}`);
    }
    if (result.rows.length > contract.maximumResults) {
      throw new RangeError(`Named query exceeded its result budget: ${registrationKey}`);
    }

    return Object.freeze({
      name: contract.name,
      contractVersion: contract.contractVersion,
      rows: Object.freeze(result.rows.map((row) => implementation.parseRow(row))),
      elapsedMs: result.elapsedMs,
      scannedBytes: result.scannedBytes,
      truncated: result.truncated,
    });
  }
}
