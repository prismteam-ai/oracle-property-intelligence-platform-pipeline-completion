import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepositoryRoot, SecretPolicyError } from "./lib.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INGRESS_POLICY_PATH = path.join(MODULE_DIRECTORY, "ingress-variables.json");
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;
const CLASSIFICATION = /^[a-z][a-z0-9_]{2,63}$/;

export class CredentialIngressError extends Error {
  constructor(code) {
    super(code);
    this.name = "CredentialIngressError";
    this.code = code;
  }
}

function fail(code) {
  throw new CredentialIngressError(code);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export async function loadIngressPolicy(policyPath = DEFAULT_INGRESS_POLICY_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(policyPath, "utf8"));
  } catch {
    fail("INGRESS_POLICY_READ_OR_PARSE_ERROR");
  }

  if (
    !exactKeys(parsed, ["schemaVersion", "variables", "forbiddenVariables"]) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.variables) ||
    parsed.variables.length === 0 ||
    !Array.isArray(parsed.forbiddenVariables)
  ) {
    fail("INGRESS_POLICY_SCHEMA_ERROR");
  }

  const allowed = new Map();
  for (const variable of parsed.variables) {
    if (
      !exactKeys(variable, ["name", "classification"]) ||
      typeof variable.name !== "string" ||
      !VARIABLE_NAME.test(variable.name) ||
      typeof variable.classification !== "string" ||
      !CLASSIFICATION.test(variable.classification) ||
      allowed.has(variable.name)
    ) {
      fail("INGRESS_POLICY_SCHEMA_ERROR");
    }
    allowed.set(variable.name, variable.classification);
  }

  const forbidden = new Set();
  for (const name of parsed.forbiddenVariables) {
    if (typeof name !== "string" || !VARIABLE_NAME.test(name) || forbidden.has(name) || allowed.has(name)) {
      fail("INGRESS_POLICY_SCHEMA_ERROR");
    }
    forbidden.add(name);
  }

  return Object.freeze({ schemaVersion: 1, allowed, forbidden });
}

function hasForbiddenPathComponent(absolutePath) {
  return path
    .resolve(absolutePath)
    .split(path.sep)
    .some((component) => component.toLowerCase() === ".config");
}

function gitStatus(repositoryRoot, args) {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: repositoryRoot,
    encoding: null,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail("INGRESS_GIT_ERROR");
  }
  return result.status;
}

function toRepositoryPath(repositoryRoot, absolutePath) {
  const relative = path.relative(repositoryRoot, absolutePath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("INGRESS_FILE_OUTSIDE_REPOSITORY");
  }
  return relative.split(path.sep).join("/");
}

async function assertSafeIngressFile(repositoryRoot, fileCandidate) {
  if (typeof fileCandidate !== "string" || fileCandidate.length === 0 || hasForbiddenPathComponent(fileCandidate)) {
    fail("INGRESS_PATH_FORBIDDEN");
  }

  const absolutePath = path.resolve(repositoryRoot, fileCandidate);
  if (hasForbiddenPathComponent(absolutePath)) {
    fail("INGRESS_PATH_FORBIDDEN");
  }

  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch {
    fail("INGRESS_FILE_STAT_ERROR");
  }
  if (stat.isSymbolicLink()) {
    fail("INGRESS_SYMLINK_FORBIDDEN");
  }
  if (!stat.isFile()) {
    fail("INGRESS_NON_REGULAR_FILE");
  }

  let resolvedFile;
  try {
    resolvedFile = await fs.realpath(absolutePath);
  } catch {
    fail("INGRESS_FILE_REALPATH_ERROR");
  }
  const relativeResolved = path.relative(repositoryRoot, resolvedFile);
  if (
    relativeResolved === "" ||
    relativeResolved === ".." ||
    relativeResolved.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeResolved) ||
    hasForbiddenPathComponent(resolvedFile)
  ) {
    fail("INGRESS_PATH_ESCAPE_FORBIDDEN");
  }
  const compare = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
  if (compare(path.resolve(absolutePath)) !== compare(resolvedFile)) {
    fail("INGRESS_PATH_ALIAS_FORBIDDEN");
  }

  const repositoryPath = toRepositoryPath(repositoryRoot, absolutePath);
  const trackedStatus = gitStatus(repositoryRoot, ["ls-files", "--error-unmatch", "--", repositoryPath]);
  if (trackedStatus === 0) {
    fail("INGRESS_FILE_TRACKED");
  }
  if (trackedStatus !== 1) {
    fail("INGRESS_GIT_ERROR");
  }

  const ignoredStatus = gitStatus(repositoryRoot, ["check-ignore", "-q", "--", repositoryPath]);
  if (ignoredStatus === 1) {
    fail("INGRESS_FILE_NOT_IGNORED");
  }
  if (ignoredStatus !== 0) {
    fail("INGRESS_GIT_ERROR");
  }
  return resolvedFile;
}

function decodeValue(rawValue) {
  if (rawValue.length === 0) {
    fail("INGRESS_EMPTY_VALUE");
  }
  const first = rawValue.at(0);
  const last = rawValue.at(-1);
  let value = rawValue;
  if (first === '"' || first === "'") {
    if (last !== first || rawValue.length < 2) {
      fail("INGRESS_QUOTE_ERROR");
    }
    value = rawValue.slice(1, -1);
  } else if (rawValue.includes('"') || rawValue.includes("'")) {
    fail("INGRESS_QUOTE_ERROR");
  }

  if (value.length === 0 || /[\u0000-\u001f\u007f]/.test(value) || /^<[^<>]+>$/.test(value)) {
    fail("INGRESS_INVALID_VALUE");
  }
  return value;
}

export function parseCredentialEnvironment(text, policy) {
  if (typeof text !== "string" || text.includes("\0")) {
    fail("INGRESS_PARSE_ERROR");
  }

  const values = Object.create(null);
  const names = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      fail("INGRESS_PARSE_ERROR");
    }
    const [, name, rawValue] = match;
    if (policy.forbidden.has(name)) {
      fail("INGRESS_FORBIDDEN_VARIABLE");
    }
    if (!policy.allowed.has(name)) {
      fail("INGRESS_UNKNOWN_VARIABLE");
    }
    if (Object.hasOwn(values, name)) {
      fail("INGRESS_DUPLICATE_VARIABLE");
    }
    values[name] = decodeValue(rawValue);
    names.push(name);
  }

  if (names.length === 0) {
    fail("INGRESS_NO_VARIABLES");
  }
  names.sort();
  return { values, names };
}

export async function loadCredentialEnvironment({ repository, file }) {
  let repositoryRoot;
  try {
    repositoryRoot = await resolveRepositoryRoot(repository);
  } catch (error) {
    if (error instanceof SecretPolicyError) {
      fail("INGRESS_REPOSITORY_IDENTITY_ERROR");
    }
    throw error;
  }

  const policy = await loadIngressPolicy();
  const safeFile = await assertSafeIngressFile(repositoryRoot, file);
  let text;
  try {
    text = await fs.readFile(safeFile, "utf8");
  } catch {
    fail("INGRESS_FILE_READ_ERROR");
  }
  const parsed = parseCredentialEnvironment(text, policy);

  const summary = Object.freeze({
    schemaVersion: 1,
    status: "valid",
    variableCount: parsed.names.length,
    variables: Object.freeze(
      parsed.names.map((name) => Object.freeze({ name, classification: policy.allowed.get(name) })),
    ),
    valuesPrinted: false,
  });

  const result = { summary };
  Object.defineProperty(result, "environment", {
    value: Object.freeze(parsed.values),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(result);
}
