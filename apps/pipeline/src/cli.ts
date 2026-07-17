import { runCheck } from './check.js';

export function main(arguments_: readonly string[]): number {
  if (arguments_.length === 1 && arguments_[0] === '--check') {
    process.stdout.write(`${JSON.stringify(runCheck())}\n`);
    return 0;
  }

  process.stderr.write('Usage: oracle-pipeline --check\n');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\\\', '/')}`) {
  process.exitCode = main(process.argv.slice(2));
}
