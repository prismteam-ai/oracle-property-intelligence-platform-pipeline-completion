#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredentialEnvironment } from "./ingress.mjs";

function parseArguments(argv) {
  let repository = process.cwd();
  let file;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--repo" && index + 1 < argv.length) {
      repository = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === "--file" && index + 1 < argv.length) {
      file = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("INGRESS_ARGUMENT_ERROR");
  }
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("INGRESS_ARGUMENT_ERROR");
  }
  return { repository, file };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    const loaded = await loadCredentialEnvironment(options);
    process.stdout.write(`${JSON.stringify(loaded.summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: "error", errorCode: error.code ?? "INGRESS_ERROR", valuesPrinted: false })}\n`,
    );
    return 2;
  }
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = await main();
}
