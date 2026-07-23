#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredentialEnvironment, loadIngressPolicy } from "./ingress.mjs";
import {
  classifyProhibitedPath,
  loadSecretPolicy,
  normalizeRepositoryPath,
  safeReportPath,
} from "./lib.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SCANNER_PATH = path.join(MODULE_DIRECTORY, "scan.mjs");
const INGRESS_VALIDATOR_PATH = path.join(MODULE_DIRECTORY, "validate-ingress.mjs");
const PROJECT_ROOT = path.resolve(MODULE_DIRECTORY, "..", "..");

let assertions = 0;

function check(condition, code) {
  assertions += 1;
  if (!condition) {
    throw new Error(code);
  }
}

function run(command, args, workingDirectory) {
  return spawnSync(command, args, {
    cwd: workingDirectory,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runGit(repository, args) {
  const result = run("git", ["-c", "init.defaultBranch=main", ...args], repository);
  check(!result.error && result.status === 0, "SELF_TEST_GIT_ERROR");
}

async function createRepository(repository) {
  await fs.mkdir(repository, { recursive: true });
  runGit(repository, ["init", "--quiet"]);
}

async function writeFixture(repository, repositoryPath, content) {
  const absolutePath = path.join(repository, ...repositoryPath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

function runScanner(repository) {
  return run(process.execPath, [SCANNER_PATH, "--repo", repository, "--format", "json"], repository);
}

function parseJsonOutput(result, code) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(code);
  }
}

function buildSyntheticSecrets() {
  const awsId = "AKIA" + "A".repeat(16);
  const awsSecret = "B".repeat(40);
  const awsSession = "C".repeat(48);
  const github = "ghp_" + "D".repeat(36);
  const githubFine = "github_pat_" + "E".repeat(30);
  const openai = "sk-" + "F".repeat(24);
  const googleApi = "AIza" + "G".repeat(35);
  const googleOauth = "ya29." + "H".repeat(24);
  const slack = "xoxb-" + "1234567890-" + "I".repeat(12);
  const jwt = "eyJ" + "J".repeat(10) + "." + "K".repeat(12) + "." + "L".repeat(12);
  const pemHeader = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const awsSignature = "X-Amz-Signature=" + "a".repeat(64);
  const googleSignature = "X-Goog-Signature=" + "b".repeat(128);
  const cloudSignature = "?Signature=" + "M".repeat(48);

  return {
    awsId,
    awsSecret,
    awsSession,
    github,
    githubFine,
    openai,
    googleApi,
    googleOauth,
    slack,
    jwt,
    pemHeader,
    awsSignature,
    googleSignature,
    cloudSignature,
  };
}

async function writePositiveFixtures(repository, secrets) {
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.mkdir(path.join(repository, "exports"), { recursive: true });
  await fs.mkdir(path.join(repository, "keys"), { recursive: true });
  await fs.writeFile(path.join(repository, ".gitignore"), ".env\n", "utf8");
  await fs.writeFile(path.join(repository, ".env"), "SAFE_NAME=synthetic\n", "utf8");
  runGit(repository, ["add", "-f", ".env"]);
  await fs.writeFile(path.join(repository, ".env.production"), "SAFE_NAME=synthetic\n", "utf8");
  await fs.writeFile(path.join(repository, "exports", "accessKeys.csv"), "synthetic\n", "utf8");
  await fs.writeFile(path.join(repository, "exports", "credential-export.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(repository, "exports", "auth-token.txt"), "synthetic\n", "utf8");
  await fs.writeFile(path.join(repository, "keys", "private-key.pem"), "synthetic\n", "utf8");

  const content = [
    secrets.awsId,
    `AWS_SECRET_ACCESS_KEY=${secrets.awsSecret}`,
    `AWS_SESSION_TOKEN=${secrets.awsSession}`,
    secrets.github,
    secrets.githubFine,
    secrets.openai,
    secrets.googleApi,
    secrets.googleOauth,
    secrets.slack,
    secrets.jwt,
    secrets.pemHeader,
    secrets.awsSignature,
    secrets.googleSignature,
    secrets.cloudSignature,
  ].join("\n");
  await fs.writeFile(path.join(repository, "src", "provider-leaks.txt"), `${content}\n`, "utf8");
}

async function testPositiveScan(root, policy, secrets) {
  const repository = path.join(root, "positive");
  await createRepository(repository);
  await writePositiveFixtures(repository, secrets);
  const splitPrefix = "Z".repeat(policy.chunkBytes - 9);
  await fs.writeFile(
    path.join(repository, "src", "chunk-boundary.txt"),
    `${splitPrefix}${secrets.openai}\n`,
    "utf8",
  );

  const result = runScanner(repository);
  check(!result.error && result.status === 1, "POSITIVE_SCAN_EXIT");
  const report = parseJsonOutput(result, "POSITIVE_SCAN_JSON");
  check(report.status === "findings" && report.errorCount === 0, "POSITIVE_SCAN_STATUS");

  const foundRules = new Set(report.findings.flatMap((finding) => finding.ruleIds));
  const requiredRules = [
    "PROHIBITED_ENV_FILE",
    "PROHIBITED_ACCESS_KEY_CSV",
    "PROHIBITED_PRIVATE_KEY_FILE",
    "PROHIBITED_TOKEN_FILE",
    "PROHIBITED_CREDENTIAL_EXPORT",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_OAUTH_TOKEN",
    "SLACK_TOKEN",
    "JWT",
    "PEM_PRIVATE_KEY",
    "AWS_PRESIGNED_SIGNATURE",
    "GOOGLE_PRESIGNED_SIGNATURE",
    "CLOUD_PRESIGNED_SIGNATURE",
  ];
  for (const ruleId of requiredRules) {
    check(foundRules.has(ruleId), `MISSING_RULE_${ruleId}`);
  }
  const boundaryFinding = report.findings.find((finding) => finding.path === "src/chunk-boundary.txt");
  check(boundaryFinding?.ruleIds.includes("OPENAI_API_KEY"), "CHUNK_BOUNDARY_DETECTION");

  for (const value of Object.values(secrets)) {
    check(!result.stdout.includes(value), "POSITIVE_OUTPUT_VALUE_LEAK");
  }

  const credentialNamedPath = `src/${secrets.github}.txt`;
  const renderedPath = safeReportPath(credentialNamedPath, policy.contentRules);
  check(renderedPath.startsWith("<redacted-path:") && !renderedPath.includes(secrets.github), "PATH_REDACTION");
}

async function testNegativeScanAndIngress(root, secrets) {
  const repository = path.join(root, "negative");
  await createRepository(repository);
  await fs.writeFile(path.join(repository, ".gitignore"), ".env.local\n", "utf8");
  const ignoredValue = secrets.awsId;
  const ignoredSecret = secrets.awsSecret;
  await fs.writeFile(
    path.join(repository, ".env.local"),
    `FILEBASE_ACCESS_KEY_ID=${ignoredValue}\nFILEBASE_SECRET_ACCESS_KEY=${ignoredSecret}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(repository, ".env.example"),
    "FILEBASE_ACCESS_KEY_ID=<runtime-injection>\nFILEBASE_SECRET_ACCESS_KEY=<runtime-injection>\n",
    "utf8",
  );
  await fs.writeFile(path.join(repository, "safe.md"), "Provider identifiers and placeholders only.\n", "utf8");

  const result = runScanner(repository);
  check(!result.error && result.status === 0, "NEGATIVE_SCAN_EXIT");
  const report = parseJsonOutput(result, "NEGATIVE_SCAN_JSON");
  check(report.status === "clean" && report.findingCount === 0 && report.errorCount === 0, "NEGATIVE_SCAN_STATUS");
  check(!result.stdout.includes(ignoredValue) && !result.stdout.includes(ignoredSecret), "NEGATIVE_OUTPUT_VALUE_LEAK");

  const loaded = await loadCredentialEnvironment({ repository, file: ".env.local" });
  check(loaded.summary.status === "valid" && loaded.summary.variableCount === 2, "INGRESS_LOAD_STATUS");
  check(!Object.keys(loaded).includes("environment"), "INGRESS_VALUES_ENUMERABLE");
  const serialized = JSON.stringify(loaded);
  check(!serialized.includes(ignoredValue) && !serialized.includes(ignoredSecret), "INGRESS_SUMMARY_VALUE_LEAK");

  const validator = run(
    process.execPath,
    [INGRESS_VALIDATOR_PATH, "--repo", repository, "--file", ".env.local"],
    repository,
  );
  check(!validator.error && validator.status === 0, "INGRESS_VALIDATOR_EXIT");
  check(!validator.stdout.includes(ignoredValue) && !validator.stdout.includes(ignoredSecret), "INGRESS_VALIDATOR_VALUE_LEAK");

  await fs.writeFile(path.join(repository, ".env.tracked"), "FILEBASE_BUCKET=synthetic\n", "utf8");
  runGit(repository, ["add", "-f", ".env.tracked"]);
  let trackedError;
  try {
    await loadCredentialEnvironment({ repository, file: ".env.tracked" });
  } catch (error) {
    trackedError = error.code;
  }
  check(trackedError === "INGRESS_FILE_TRACKED", "INGRESS_TRACKED_REJECTION");

  await fs.writeFile(path.join(repository, ".env.unignored"), "FILEBASE_BUCKET=synthetic\n", "utf8");
  let unignoredError;
  try {
    await loadCredentialEnvironment({ repository, file: ".env.unignored" });
  } catch (error) {
    unignoredError = error.code;
  }
  check(unignoredError === "INGRESS_FILE_NOT_IGNORED", "INGRESS_UNIGNORED_REJECTION");

  let configError;
  try {
    await loadCredentialEnvironment({ repository, file: path.join(".config", "credentials.env") });
  } catch (error) {
    configError = error.code;
  }
  check(configError === "INGRESS_PATH_FORBIDDEN", "INGRESS_CONFIG_REJECTION");
}

async function testRepositoryIgnoreBoundary(root, secrets) {
  const repository = path.join(root, "ignore-boundary");
  await createRepository(repository);
  const gitignore = await fs.readFile(path.join(PROJECT_ROOT, ".gitignore"), "utf8");
  await fs.writeFile(path.join(repository, ".gitignore"), gitignore, "utf8");

  const ignoredFixtures = new Map([
    ["provider.env", `AWS_ACCESS_KEY_ID=${secrets.awsId}\n`],
    [".config/aws.env", `AWS_SECRET_ACCESS_KEY=${secrets.awsSecret}\n`],
    [".aws/credentials", `[synthetic]\naws_access_key_id=${secrets.awsId}\n`],
    ["token.json", `${JSON.stringify({ token: secrets.github })}\n`],
    [".npmrc", `//registry.invalid/:_authToken=${secrets.github}\n`],
  ]);
  const visibleFixtures = new Map([
    [".env.example", "FILEBASE_ACCESS_KEY_ID=<runtime-injection>\n"],
    ["src/provider.ts", 'export const provider = "synthetic";\n'],
    ["fixtures/provider-response.json", '{"status":"synthetic"}\n'],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
    [".assessment/evidence/scan.json", '{"status":"synthetic"}\n'],
  ]);

  for (const [repositoryPath, content] of [...ignoredFixtures, ...visibleFixtures]) {
    await writeFixture(repository, repositoryPath, content);
  }

  for (const repositoryPath of ignoredFixtures.keys()) {
    const result = run(
      "git",
      ["-c", "core.quotepath=false", "check-ignore", "--no-index", "-q", "--", repositoryPath],
      repository,
    );
    check(!result.error && result.status === 0, `IGNORE_POSITIVE_${repositoryPath.replaceAll(/[^A-Za-z0-9]/g, "_")}`);
  }

  for (const repositoryPath of visibleFixtures.keys()) {
    const result = run(
      "git",
      ["-c", "core.quotepath=false", "check-ignore", "--no-index", "-q", "--", repositoryPath],
      repository,
    );
    check(!result.error && result.status === 1, `IGNORE_NEGATIVE_${repositoryPath.replaceAll(/[^A-Za-z0-9]/g, "_")}`);
  }

  const enumeration = run(
    "git",
    ["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    repository,
  );
  check(!enumeration.error && enumeration.status === 0, "IGNORE_ENUMERATION_EXIT");
  const candidates = new Set(enumeration.stdout.split("\0").filter((value) => value.length > 0));
  for (const repositoryPath of ignoredFixtures.keys()) {
    check(!candidates.has(repositoryPath), `IGNORED_PATH_ENUMERATED_${repositoryPath.replaceAll(/[^A-Za-z0-9]/g, "_")}`);
  }
  for (const repositoryPath of visibleFixtures.keys()) {
    check(candidates.has(repositoryPath), `VISIBLE_PATH_MISSING_${repositoryPath.replaceAll(/[^A-Za-z0-9]/g, "_")}`);
  }
  check(candidates.size === visibleFixtures.size + 1, "IGNORE_ENUMERATION_COUNT");

  const result = runScanner(repository);
  check(!result.error && result.status === 0, "IGNORED_CREDENTIAL_SCAN_EXIT");
  const report = parseJsonOutput(result, "IGNORED_CREDENTIAL_SCAN_JSON");
  check(
    report.status === "clean" &&
      report.findingCount === 0 &&
      report.errorCount === 0 &&
      report.filesEnumerated === candidates.size &&
      report.contentFilesScanned === candidates.size,
    "IGNORED_CREDENTIAL_SCAN_BOUNDARY",
  );
  for (const value of Object.values(secrets)) {
    check(!result.stdout.includes(value), "IGNORED_CREDENTIAL_OUTPUT_VALUE_LEAK");
  }
}

async function testTrackedProhibitedPathPreRead(root, secrets) {
  const repository = path.join(root, "tracked-prohibited");
  await createRepository(repository);
  await fs.writeFile(path.join(repository, ".gitignore"), "/.env\n", "utf8");
  await fs.writeFile(path.join(repository, ".env"), `AWS_ACCESS_KEY_ID=${secrets.awsId}\n`, "utf8");
  runGit(repository, ["add", "-f", "--", ".env"]);

  const tracked = run(
    "git",
    ["-c", "core.quotepath=false", "ls-files", "--error-unmatch", "--", ".env"],
    repository,
  );
  check(!tracked.error && tracked.status === 0, "TRACKED_PROHIBITED_NOT_IN_INDEX");

  // Deleting the worktree file makes any stat/content read fail. A clean policy
  // finding therefore proves cached enumeration and path rejection happen first.
  await fs.unlink(path.join(repository, ".env"));
  const result = runScanner(repository);
  check(!result.error && result.status === 1, "TRACKED_PROHIBITED_SCAN_EXIT");
  const report = parseJsonOutput(result, "TRACKED_PROHIBITED_SCAN_JSON");
  const finding = report.findings.find((entry) => entry.path === ".env");
  check(
    report.status === "findings" &&
      report.errorCount === 0 &&
      report.filesEnumerated === 2 &&
      report.contentFilesScanned === 1,
    "TRACKED_PROHIBITED_SCAN_BOUNDARY",
  );
  check(
    finding?.ruleIds.length === 1 && finding.ruleIds[0] === "PROHIBITED_ENV_FILE",
    "TRACKED_PROHIBITED_PATH_ONLY_FINDING",
  );
  check(!result.stdout.includes(secrets.awsId), "TRACKED_PROHIBITED_OUTPUT_VALUE_LEAK");
}

async function testFailClosed(root) {
  const missingRepository = path.join(root, "missing-file");
  await createRepository(missingRepository);
  await fs.writeFile(path.join(missingRepository, "missing.txt"), "synthetic\n", "utf8");
  runGit(missingRepository, ["add", "missing.txt"]);
  await fs.unlink(path.join(missingRepository, "missing.txt"));
  const missingResult = runScanner(missingRepository);
  check(!missingResult.error && missingResult.status === 2, "MISSING_FILE_EXIT");
  const missingReport = parseJsonOutput(missingResult, "MISSING_FILE_JSON");
  check(
    missingReport.status === "error" &&
      missingReport.errors.some((entry) => entry.ruleId === "SCAN_FILE_STAT_ERROR"),
    "MISSING_FILE_FAIL_CLOSED",
  );

  const nonRepository = path.join(root, "not-a-repository");
  await fs.mkdir(nonRepository, { recursive: true });
  const identityResult = runScanner(nonRepository);
  check(!identityResult.error && identityResult.status === 2, "IDENTITY_EXIT");
  const identityReport = parseJsonOutput(identityResult, "IDENTITY_JSON");
  check(
    identityReport.status === "error" &&
      identityReport.errors.some((entry) => entry.ruleId === "REPOSITORY_IDENTITY_ERROR"),
    "IDENTITY_FAIL_CLOSED",
  );
}

async function testPathNormalization(policy) {
  check(normalizeRepositoryPath("nested\\folder\\safe.txt") === "nested/folder/safe.txt", "WINDOWS_NORMALIZATION");
  check(normalizeRepositoryPath("nested/folder/safe.txt") === "nested/folder/safe.txt", "LINUX_NORMALIZATION");
  check(
    classifyProhibitedPath("nested\\.env.production", policy.pathRules).includes("PROHIBITED_ENV_FILE"),
    "WINDOWS_ENV_CLASSIFICATION",
  );
  check(
    classifyProhibitedPath("nested/access-keys.csv", policy.pathRules).includes("PROHIBITED_ACCESS_KEY_CSV"),
    "LINUX_ACCESS_KEY_CLASSIFICATION",
  );
  let traversalRejected = false;
  try {
    normalizeRepositoryPath("../outside.txt");
  } catch {
    traversalRejected = true;
  }
  check(traversalRejected, "TRAVERSAL_REJECTION");
}

async function testExampleContract() {
  const ingressPolicy = await loadIngressPolicy();
  const text = await fs.readFile(path.join(PROJECT_ROOT, ".env.example"), "utf8");
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(<[^<>]+>)$/.exec(line);
    check(match !== null, "ENV_EXAMPLE_NOT_VALUE_FREE");
    check(!names.has(match[1]), "ENV_EXAMPLE_DUPLICATE");
    check(ingressPolicy.allowed.has(match[1]), "ENV_EXAMPLE_UNKNOWN_NAME");
    names.add(match[1]);
  }
  check(names.size === ingressPolicy.allowed.size, "ENV_EXAMPLE_POLICY_DRIFT");
}

async function main() {
  const temporaryBase = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryBase, "oracle-secret-policy-"));
  try {
    const policy = await loadSecretPolicy();
    const secrets = buildSyntheticSecrets();
    await testPathNormalization(policy);
    await testPositiveScan(root, policy, secrets);
    await testNegativeScanAndIngress(root, secrets);
    await testRepositoryIgnoreBoundary(root, secrets);
    await testTrackedProhibitedPathPreRead(root, secrets);
    await testFailClosed(root);
    await testExampleContract();
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: "pass", assertions, fixtures: "temporary-only", valuesPrinted: false })}\n`,
    );
    return 0;
  } catch (error) {
    const errorCode = /^[A-Z0-9_]+$/.test(error.message) ? error.message : "SECRET_POLICY_SELF_TEST_ERROR";
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: "fail", errorCode, valuesPrinted: false })}\n`,
    );
    return 1;
  } finally {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(temporaryBase, resolvedRoot);
    if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      await fs.rm(resolvedRoot, { recursive: true, force: true });
    }
  }
}

process.exitCode = await main();
