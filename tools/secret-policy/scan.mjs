#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTextReport, reportExitCode, scanRepository } from "./lib.mjs";

function parseArguments(argv) {
  let repository = process.cwd();
  let format = "text";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo" && index + 1 < argv.length) {
      repository = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--format" && index + 1 < argv.length) {
      format = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("ARGUMENT_ERROR");
  }

  if (!new Set(["text", "json"]).has(format)) {
    throw new Error("ARGUMENT_ERROR");
  }
  return { repository, format };
}

export async function main(argv = process.argv.slice(2)) {
  let argumentsResult;
  try {
    argumentsResult = parseArguments(argv);
  } catch {
    process.stdout.write(
      '{"schemaVersion":1,"scannerVersion":"1.0.0","status":"error","errorCount":1,"errors":[{"path":"<arguments>","ruleId":"ARGUMENT_ERROR"}]}\n',
    );
    return 2;
  }

  const report = await scanRepository(argumentsResult.repository);
  if (argumentsResult.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderTextReport(report));
  }
  return reportExitCode(report);
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = await main();
}
