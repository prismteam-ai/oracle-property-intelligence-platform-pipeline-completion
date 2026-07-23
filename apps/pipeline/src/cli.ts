import { runCheck } from './check.js';
import {
  runPublicClosureCommand,
  type PublicClosureCommandOptions,
} from './commands/build-public-serving-closure.js';
import { runCommand } from './commands/run.js';
import type { RunProfileName } from './orchestration/types.js';
import { pathToFileURL } from 'node:url';

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function usage(): void {
  process.stderr.write(
    'Usage: oracle-pipeline --check | <discovery|pilot|full|incremental> [--fixture] [--source-config <json>] [--requested-at <iso>] [--workspace <repo>] --output <directory> | public-closure --run-root <root> --run-manifest <stdout-json> --authorization-policy <json> --private-key-file <pem> --output <directory>\n',
  );
}

export function parsePublicClosureArguments(
  arguments_: readonly string[],
): PublicClosureCommandOptions | undefined {
  if (arguments_[0] !== 'public-closure' || arguments_.length !== 11) return undefined;
  const values = new Map<string, string>();
  const allowed = new Set([
    '--run-root',
    '--run-manifest',
    '--authorization-policy',
    '--private-key-file',
    '--output',
  ]);
  for (let index = 1; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !allowed.has(name) ||
      values.has(name) ||
      value.length === 0 ||
      value.startsWith('--')
    ) {
      return undefined;
    }
    values.set(name, value);
  }
  const runRoot = values.get('--run-root');
  const runManifestPath = values.get('--run-manifest');
  const authorizationPolicyPath = values.get('--authorization-policy');
  const privateKeyPath = values.get('--private-key-file');
  const outputDirectory = values.get('--output');
  if (
    runRoot === undefined ||
    runManifestPath === undefined ||
    authorizationPolicyPath === undefined ||
    privateKeyPath === undefined ||
    outputDirectory === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    runRoot,
    runManifestPath,
    authorizationPolicyPath,
    privateKeyPath,
    outputDirectory,
  });
}

export async function main(arguments_: readonly string[]): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === '--check') {
    process.stdout.write(`${JSON.stringify(runCheck())}\n`);
    return 0;
  }

  if (arguments_[0] === 'public-closure') {
    const options = parsePublicClosureArguments(arguments_);
    if (options === undefined) {
      usage();
      return 2;
    }
    const summary = await runPublicClosureCommand(options);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  }

  const profile = arguments_[0] as RunProfileName | undefined;
  if (
    profile === 'discovery' ||
    profile === 'pilot' ||
    profile === 'full' ||
    profile === 'incremental'
  ) {
    const output = option(arguments_, '--output');
    if (output === undefined) {
      usage();
      return 2;
    }
    const sourceConfigPath = option(arguments_, '--source-config');
    const requestedAt = option(arguments_, '--requested-at');
    const result = await runCommand({
      profile,
      workspaceDirectory: option(arguments_, '--workspace') ?? process.cwd(),
      outputDirectory: output,
      fixture: arguments_.includes('--fixture'),
      ...(sourceConfigPath === undefined ? {} : { sourceConfigPath }),
      ...(requestedAt === undefined ? {} : { requestedAt }),
    });
    process.stdout.write(`${JSON.stringify(result.manifest)}\n`);
    return result.manifest.status === 'failed' ? 1 : 0;
  }

  usage();
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
