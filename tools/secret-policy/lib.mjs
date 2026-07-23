import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = path.join(MODULE_DIRECTORY, "policy.json");
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const SAFE_RULE_ID = /^[A-Z][A-Z0-9_]{2,63}$/;
const ALLOWED_REGEX_FLAGS = /^[gimsu]*$/;

export class SecretPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "SecretPolicyError";
    this.code = code;
  }
}

function fail(code) {
  throw new SecretPolicyError(code);
}

function assertPlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code);
  }
}

function assertExactKeys(value, expectedKeys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function compileRegex(pattern, flags, code) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 4096) {
    fail(code);
  }
  if (typeof flags !== "string" || !ALLOWED_REGEX_FLAGS.test(flags)) {
    fail(code);
  }

  try {
    return new RegExp(pattern, flags);
  } catch {
    fail(code);
  }
}

export async function loadSecretPolicy(policyPath = DEFAULT_POLICY_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(policyPath, "utf8"));
  } catch {
    fail("POLICY_READ_OR_PARSE_ERROR");
  }

  assertPlainObject(parsed, "POLICY_SCHEMA_ERROR");
  assertExactKeys(
    parsed,
    [
      "schemaVersion",
      "policyVersion",
      "chunkBytes",
      "overlapBytes",
      "pathRules",
      "contentRules",
    ],
    "POLICY_SCHEMA_ERROR",
  );

  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.policyVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(parsed.policyVersion) ||
    !Number.isSafeInteger(parsed.chunkBytes) ||
    parsed.chunkBytes < 4096 ||
    parsed.chunkBytes > 1024 * 1024 ||
    !Number.isSafeInteger(parsed.overlapBytes) ||
    parsed.overlapBytes < 1024 ||
    parsed.overlapBytes >= parsed.chunkBytes ||
    !Array.isArray(parsed.pathRules) ||
    parsed.pathRules.length === 0 ||
    !Array.isArray(parsed.contentRules) ||
    parsed.contentRules.length === 0
  ) {
    fail("POLICY_SCHEMA_ERROR");
  }

  const ids = new Set();
  const pathRules = parsed.pathRules.map((rule) => {
    assertPlainObject(rule, "POLICY_PATH_RULE_ERROR");
    assertExactKeys(rule, ["id", "pattern", "allowedBasenames"], "POLICY_PATH_RULE_ERROR");
    if (
      typeof rule.id !== "string" ||
      !SAFE_RULE_ID.test(rule.id) ||
      ids.has(rule.id) ||
      !Array.isArray(rule.allowedBasenames) ||
      rule.allowedBasenames.some(
        (name) => typeof name !== "string" || name.length === 0 || name.includes("/") || name.includes("\\"),
      )
    ) {
      fail("POLICY_PATH_RULE_ERROR");
    }
    ids.add(rule.id);
    return {
      id: rule.id,
      regex: compileRegex(rule.pattern, "i", "POLICY_PATH_RULE_ERROR"),
      allowedBasenames: new Set(rule.allowedBasenames.map((name) => name.toLowerCase())),
    };
  });

  const contentRules = parsed.contentRules.map((rule) => {
    assertPlainObject(rule, "POLICY_CONTENT_RULE_ERROR");
    assertExactKeys(rule, ["id", "pattern", "flags"], "POLICY_CONTENT_RULE_ERROR");
    if (typeof rule.id !== "string" || !SAFE_RULE_ID.test(rule.id) || ids.has(rule.id)) {
      fail("POLICY_CONTENT_RULE_ERROR");
    }
    ids.add(rule.id);
    return {
      id: rule.id,
      regex: compileRegex(rule.pattern, rule.flags, "POLICY_CONTENT_RULE_ERROR"),
    };
  });

  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    policyVersion: parsed.policyVersion,
    chunkBytes: parsed.chunkBytes,
    overlapBytes: parsed.overlapBytes,
    pathRules: Object.freeze(pathRules),
    contentRules: Object.freeze(contentRules),
  });
}

export function normalizeRepositoryPath(input) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    fail("INVALID_REPOSITORY_PATH");
  }

  const slashPath = input.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:\//.test(slashPath)) {
    fail("ABSOLUTE_REPOSITORY_PATH");
  }

  const normalized = path.posix.normalize(slashPath).replace(/^\.\//, "");
  if (
    normalized === "." ||
    normalized === "" ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  ) {
    fail("INVALID_REPOSITORY_PATH");
  }
  return normalized;
}

export function classifyProhibitedPath(input, pathRules) {
  const normalized = normalizeRepositoryPath(input);
  const basename = path.posix.basename(normalized).toLowerCase();
  const findings = [];
  for (const rule of pathRules) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(normalized) && !rule.allowedBasenames.has(basename)) {
      findings.push(rule.id);
    }
  }
  return [...new Set(findings)].sort();
}

export function detectSecretRuleIds(text, contentRules) {
  if (typeof text !== "string") {
    fail("INVALID_SCAN_TEXT");
  }
  const findings = [];
  for (const rule of contentRules) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text)) {
      findings.push(rule.id);
    }
  }
  return findings.sort();
}

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export function safeReportPath(input, contentRules) {
  if (typeof input !== "string") {
    return "<redacted-path:invalid>";
  }
  const containsControlCharacter = /[\u0000-\u001f\u007f]/.test(input);
  const containsCredentialPattern = detectSecretRuleIds(input, contentRules).length > 0;
  if (containsControlCharacter || containsCredentialPattern || input.length > 300) {
    return `<redacted-path:${hashText(input)}>`;
  }
  return input;
}

function runGit(repositoryRoot, args) {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: repositoryRoot,
    encoding: null,
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail("GIT_COMMAND_ERROR");
  }
  return result.stdout;
}

function hasForbiddenConfigComponent(absolutePath) {
  return path
    .resolve(absolutePath)
    .split(path.sep)
    .some((component) => component.toLowerCase() === ".config");
}

export async function resolveRepositoryRoot(repositoryCandidate) {
  if (typeof repositoryCandidate !== "string" || repositoryCandidate.length === 0) {
    fail("REPOSITORY_IDENTITY_ERROR");
  }
  if (hasForbiddenConfigComponent(repositoryCandidate)) {
    fail("REPOSITORY_PATH_FORBIDDEN");
  }

  let requestedRoot;
  try {
    requestedRoot = await fs.realpath(path.resolve(repositoryCandidate));
    const stat = await fs.lstat(requestedRoot);
    if (!stat.isDirectory()) {
      fail("REPOSITORY_IDENTITY_ERROR");
    }
  } catch (error) {
    if (error instanceof SecretPolicyError) {
      throw error;
    }
    fail("REPOSITORY_IDENTITY_ERROR");
  }

  let reportedRoot;
  try {
    const output = runGit(requestedRoot, ["rev-parse", "--show-toplevel"]);
    const decoded = output.toString("utf8").trim();
    if (decoded.length === 0 || decoded.includes("\0") || hasForbiddenConfigComponent(decoded)) {
      fail("REPOSITORY_IDENTITY_ERROR");
    }
    reportedRoot = await fs.realpath(decoded);
  } catch (error) {
    if (error instanceof SecretPolicyError) {
      throw new SecretPolicyError("REPOSITORY_IDENTITY_ERROR");
    }
    fail("REPOSITORY_IDENTITY_ERROR");
  }

  const comparison = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
  if (comparison(requestedRoot) !== comparison(reportedRoot)) {
    fail("REPOSITORY_IDENTITY_ERROR");
  }
  return reportedRoot;
}

export function listTrackedAndUnignoredFiles(repositoryRoot) {
  let output;
  try {
    output = runGit(repositoryRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  } catch {
    fail("REPOSITORY_ENUMERATION_ERROR");
  }

  const decoded = output.toString("utf8");
  const rawPaths = decoded.split("\0");
  if (rawPaths.at(-1) !== "") {
    fail("REPOSITORY_ENUMERATION_ERROR");
  }
  rawPaths.pop();

  const normalized = rawPaths.map((candidate) => normalizeRepositoryPath(candidate));
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) {
    fail("REPOSITORY_ENUMERATION_ERROR");
  }
  return unique;
}

function pathIsInsideRoot(repositoryRoot, resolvedFile) {
  const relative = path.relative(repositoryRoot, resolvedFile);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function scanRegularFile(absolutePath, policy) {
  const found = new Set();
  const readBuffer = Buffer.allocUnsafe(policy.chunkBytes);
  let carry = Buffer.alloc(0);
  let handle;

  try {
    handle = await fs.open(absolutePath, "r");
    while (true) {
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const combined = Buffer.concat([carry, readBuffer.subarray(0, bytesRead)]);
      const text = combined.toString("latin1");
      for (const ruleId of detectSecretRuleIds(text, policy.contentRules)) {
        found.add(ruleId);
      }
      carry = combined.subarray(Math.max(0, combined.length - policy.overlapBytes));
    }
  } catch {
    fail("SCAN_FILE_READ_ERROR");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        fail("SCAN_FILE_CLOSE_ERROR");
      }
    }
  }
  return [...found].sort();
}

function createBaseReport(policyVersion) {
  return {
    schemaVersion: 1,
    scannerVersion: "1.0.0",
    policyVersion,
    status: "clean",
    filesEnumerated: 0,
    contentFilesScanned: 0,
    findingCount: 0,
    findings: [],
    errorCount: 0,
    errors: [],
  };
}

export async function scanRepository(repositoryCandidate, policy = undefined) {
  let activePolicy = policy;
  try {
    activePolicy ??= await loadSecretPolicy();
  } catch (error) {
    const report = createBaseReport("unavailable");
    report.status = "error";
    report.errorCount = 1;
    report.errors = [{ path: "<policy>", ruleId: error.code ?? "POLICY_ERROR" }];
    return report;
  }

  const report = createBaseReport(activePolicy.policyVersion);
  let repositoryRoot;
  let candidateFiles;
  try {
    repositoryRoot = await resolveRepositoryRoot(repositoryCandidate);
    candidateFiles = listTrackedAndUnignoredFiles(repositoryRoot);
  } catch (error) {
    report.status = "error";
    report.errorCount = 1;
    report.errors = [{ path: "<repository>", ruleId: error.code ?? "REPOSITORY_IDENTITY_ERROR" }];
    return report;
  }

  report.filesEnumerated = candidateFiles.length;

  for (const repositoryPath of candidateFiles) {
    const reportPath = safeReportPath(repositoryPath, activePolicy.contentRules);
    const pathRuleIds = classifyProhibitedPath(repositoryPath, activePolicy.pathRules);
    if (pathRuleIds.length > 0) {
      report.findings.push({ path: reportPath, ruleIds: pathRuleIds });
      continue;
    }

    const absolutePath = path.join(repositoryRoot, ...repositoryPath.split("/"));
    try {
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new SecretPolicyError("SCAN_SYMLINK_ERROR");
      }
      if (!stat.isFile()) {
        throw new SecretPolicyError("SCAN_NON_REGULAR_FILE_ERROR");
      }
      const resolvedFile = await fs.realpath(absolutePath);
      if (!pathIsInsideRoot(repositoryRoot, resolvedFile)) {
        throw new SecretPolicyError("SCAN_PATH_ESCAPE_ERROR");
      }

      const contentRuleIds = await scanRegularFile(resolvedFile, activePolicy);
      report.contentFilesScanned += 1;
      if (contentRuleIds.length > 0) {
        report.findings.push({ path: reportPath, ruleIds: contentRuleIds });
      }
    } catch (error) {
      report.errors.push({
        path: reportPath,
        ruleId: error instanceof SecretPolicyError ? error.code : "SCAN_FILE_STAT_ERROR",
      });
    }
  }

  report.findings.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  report.errors.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  report.findingCount = report.findings.reduce((count, finding) => count + finding.ruleIds.length, 0);
  report.errorCount = report.errors.length;
  report.status = report.errorCount > 0 ? "error" : report.findingCount > 0 ? "findings" : "clean";
  return report;
}

export function reportExitCode(report) {
  if (report.status === "clean") {
    return 0;
  }
  if (report.status === "findings") {
    return 1;
  }
  return 2;
}

export function renderTextReport(report) {
  const lines = [
    `secret-policy status=${report.status} files=${report.filesEnumerated} scanned=${report.contentFilesScanned} findings=${report.findingCount} errors=${report.errorCount}`,
  ];
  for (const finding of report.findings) {
    lines.push(`FINDING path=${finding.path} rules=${finding.ruleIds.join(",")}`);
  }
  for (const error of report.errors) {
    lines.push(`ERROR path=${error.path} rule=${error.ruleId}`);
  }
  return `${lines.join("\n")}\n`;
}
