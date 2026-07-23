import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONTRACT_PATH,
  DEFAULT_LOCK_PATH,
  readJsonFile,
  validateDependencyLockFiles,
} from "./validate-dependency-lock.mts";

type JsonObject = Record<string, unknown>;

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR_PATH = join(HERE, "validate-dependency-lock.mts");

function asObject(value: unknown, label: string): JsonObject {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} object`);
  return value as JsonObject;
}

function sourceRecords(lock: JsonObject): JsonObject[] {
  assert.ok(Array.isArray(lock.sources), "fixture sources array");
  return lock.sources.map((source, index) => asObject(source, `source ${index}`));
}

function cloneObject(value: unknown): JsonObject {
  return asObject(structuredClone(value), "cloned fixture");
}

async function writeFixture(directory: string, name: string, value: unknown): Promise<string> {
  const path = join(directory, `${name}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

async function main(): Promise<void> {
  const [canonicalLock, canonicalContract] = await Promise.all([
    readJsonFile(DEFAULT_LOCK_PATH),
    readJsonFile(DEFAULT_CONTRACT_PATH),
  ]);
  const validResult = await validateDependencyLockFiles();
  assert.equal(validResult.ok, true, validResult.errors.join("\n"));
  assert.equal(validResult.sourceCount, 6);

  const temporaryDirectory = await mkdtemp(join(HERE, ".dependency-lock-self-test-"));
  const relativeTemporaryDirectory = relative(HERE, resolve(temporaryDirectory));
  assert.ok(
    relativeTemporaryDirectory.length > 0 &&
      relativeTemporaryDirectory !== ".." &&
      !relativeTemporaryDirectory.startsWith(`..${sep}`) &&
      !isAbsolute(relativeTemporaryDirectory),
    "temporary fixture directory must remain under config/dependencies",
  );

  let caseCount = 1;
  let cliInvalidFixture = "";

  const expectInvalidLock = async (
    name: string,
    mutate: (lock: JsonObject) => void,
    expectedErrorFragment: string,
  ): Promise<string> => {
    const fixture = cloneObject(canonicalLock);
    mutate(fixture);
    const fixturePath = await writeFixture(temporaryDirectory, name, fixture);
    const result = await validateDependencyLockFiles(fixturePath, DEFAULT_CONTRACT_PATH);
    assert.equal(result.ok, false, `${name} must fail`);
    assert.ok(
      result.errors.some((error) => error.includes(expectedErrorFragment)),
      `${name} must report ${JSON.stringify(expectedErrorFragment)}; got:\n${result.errors.join("\n")}`,
    );
    caseCount += 1;
    return fixturePath;
  };

  try {
    cliInvalidFixture = await expectInvalidLock(
      "moving-ref",
      (lock) => {
        sourceRecords(lock)[0].pinnedRef = "main";
      },
      "not a moving ref",
    );

    await expectInvalidLock(
      "abbreviated-sha",
      (lock) => {
        const source = sourceRecords(lock)[0];
        source.commitSha = "8ce93b3a162e";
        source.pinnedRef = "8ce93b3a162e";
      },
      "exact 40-character lowercase SHA",
    );

    await expectInvalidLock(
      "unrecognized-state",
      (lock) => {
        sourceRecords(lock)[0].dependencyState = "ready_to_float";
      },
      "unrecognized state",
    );

    await expectInvalidLock(
      "local-path-dependency",
      (lock) => {
        sourceRecords(lock)[0].canonicalUrl = "E:\\Coding\\Soofi\\elephant-skills";
      },
      "local-path dependency",
    );

    await expectInvalidLock(
      "duplicate-repository",
      (lock) => {
        const sources = sourceRecords(lock);
        sources[1] = cloneObject(sources[0]);
        lock.sources = sources;
      },
      "duplicates",
    );

    await expectInvalidLock(
      "missing-ownership",
      (lock) => {
        const ownership = asObject(sourceRecords(lock)[0].ownershipBoundary, "ownership");
        delete ownership.assessmentIntegrationOwner;
      },
      "assessmentIntegrationOwner is required",
    );

    await expectInvalidLock(
      "unapproved-redistribution-claim",
      (lock) => {
        const redistribution = asObject(sourceRecords(lock)[0].redistribution, "redistribution");
        redistribution.claim = "source_copy";
      },
      "unapproved redistribution claim",
    );

    await expectInvalidLock(
      "approved-claim-without-evidence",
      (lock) => {
        const redistribution = asObject(sourceRecords(lock)[0].redistribution, "redistribution");
        redistribution.state = "approved";
        redistribution.claim = "patch_distribution";
      },
      "approvalAuthority must be a non-empty string",
    );

    await expectInvalidLock(
      "unexpected-local-path-field",
      (lock) => {
        sourceRecords(lock)[0].localPath = "..\\elephant-skills";
      },
      "localPath is not allowed",
    );

    const relaxedContract = cloneObject(canonicalContract);
    const allowedStates = asObject(relaxedContract.allowedStates, "allowedStates");
    assert.ok(Array.isArray(allowedStates.dependency), "dependency states array");
    allowedStates.dependency.push("ready_to_float");
    const relaxedContractPath = await writeFixture(
      temporaryDirectory,
      "relaxed-contract",
      relaxedContract,
    );
    const relaxedContractResult = await validateDependencyLockFiles(
      DEFAULT_LOCK_PATH,
      relaxedContractPath,
    );
    assert.equal(relaxedContractResult.ok, false, "contract relaxation must fail");
    assert.ok(
      relaxedContractResult.errors.some((error) =>
        error.includes("contract.allowedStates.dependency must exactly equal"),
      ),
      relaxedContractResult.errors.join("\n"),
    );
    caseCount += 1;

    const validCli = spawnSync(process.execPath, [VALIDATOR_PATH, "--json"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(validCli.status, 0, validCli.stderr);
    assert.match(validCli.stdout, /"ok": true/);
    caseCount += 1;

    const invalidCli = spawnSync(
      process.execPath,
      [VALIDATOR_PATH, "--lock", cliInvalidFixture],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(invalidCli.status, 1, invalidCli.stderr);
    assert.match(invalidCli.stderr, /dependency-lock validation: FAIL/);
    caseCount += 1;

    process.stdout.write(`dependency-lock self-test: PASS (${caseCount} cases)\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`dependency-lock self-test: FAIL\n${detail}\n`);
  process.exitCode = 1;
});
