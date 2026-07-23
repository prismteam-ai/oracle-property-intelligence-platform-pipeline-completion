#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = path.join(MODULE_DIRECTORY, "registry.json");
const DEFAULT_SCHEMA = path.join(MODULE_DIRECTORY, "schema.json");
const ALLOWED_STATES = ["adopted", "adapted", "not_applicable", "exception_pending"];
const ALLOWED_OPERATIONAL_STATUSES = new Set([
  "not_started",
  "locally_verified",
  "live_verified",
  "unverified_external",
  "not_used",
]);
const REQUIRED_INTEGRATIONS = new Set([
  "agentcore-memory",
  "aws-oidc",
  "chat-sdk",
  "langsmith",
  "lexicon",
  "main-dashboard",
  "pagerduty",
  "shared-ci-cd",
]);
const ENTRY_KEYS = [
  "id",
  "name",
  "sourceContract",
  "state",
  "operationalStatus",
  "liveClaim",
  "owner",
  "evidenceOrTrigger",
  "dataHandlingImpact",
  "releaseConsequence",
];

export class ApplicabilityValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ApplicabilityValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ApplicabilityValidationError(code);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function arraysEqual(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function validText(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2000 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function validateSchemaObject(schema) {
  if (
    !isPlainObject(schema) ||
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !isPlainObject(schema.$defs) ||
    !isPlainObject(schema.$defs.entry) ||
    schema.$defs.entry.additionalProperties !== false ||
    !isPlainObject(schema.$defs.entry.properties) ||
    !isPlainObject(schema.$defs.entry.properties.state) ||
    !arraysEqual(schema.$defs.entry.properties.state.enum, ALLOWED_STATES)
  ) {
    fail("APPLICABILITY_SCHEMA_ERROR");
  }
}

export function validateRegistryObject(registry, schema) {
  validateSchemaObject(schema);
  if (
    !hasExactKeys(registry, [
      "$schema",
      "schemaVersion",
      "assessment",
      "decisionScope",
      "sourcePins",
      "allowedStates",
      "entries",
    ]) ||
    registry.$schema !== "./schema.json" ||
    registry.schemaVersion !== 1 ||
    registry.assessment !== "oracle-property-intelligence-platform-pipeline-completion" ||
    !validText(registry.decisionScope) ||
    !arraysEqual(registry.allowedStates, ALLOWED_STATES) ||
    !hasExactKeys(registry.sourcePins, ["teamKitCommit", "operatingModel", "oracleTasks"]) ||
    !/^[0-9a-f]{40}$/.test(registry.sourcePins.teamKitCommit) ||
    !validText(registry.sourcePins.operatingModel) ||
    !validText(registry.sourcePins.oracleTasks) ||
    !Array.isArray(registry.entries) ||
    registry.entries.length < REQUIRED_INTEGRATIONS.size
  ) {
    fail("APPLICABILITY_REGISTRY_ERROR");
  }

  const ids = new Set();
  let previousId = "";
  const states = Object.fromEntries(ALLOWED_STATES.map((state) => [state, 0]));
  const operationalStatuses = Object.fromEntries([...ALLOWED_OPERATIONAL_STATUSES].sort().map((status) => [status, 0]));

  for (const entry of registry.entries) {
    if (
      !hasExactKeys(entry, ENTRY_KEYS) ||
      typeof entry.id !== "string" ||
      !/^[a-z][a-z0-9-]+$/.test(entry.id) ||
      ids.has(entry.id) ||
      entry.id <= previousId ||
      !validText(entry.name) ||
      !validText(entry.sourceContract) ||
      !ALLOWED_STATES.includes(entry.state) ||
      !ALLOWED_OPERATIONAL_STATUSES.has(entry.operationalStatus) ||
      typeof entry.liveClaim !== "boolean" ||
      !validText(entry.owner) ||
      !validText(entry.evidenceOrTrigger) ||
      !validText(entry.dataHandlingImpact) ||
      !validText(entry.releaseConsequence)
    ) {
      fail("APPLICABILITY_ENTRY_ERROR");
    }

    if (
      (entry.state === "exception_pending" &&
        (entry.operationalStatus !== "unverified_external" || entry.liveClaim)) ||
      (entry.state === "not_applicable" && (entry.operationalStatus !== "not_used" || entry.liveClaim)) ||
      (["adopted", "adapted"].includes(entry.state) &&
        !["not_started", "locally_verified", "live_verified"].includes(entry.operationalStatus)) ||
      (entry.operationalStatus === "live_verified" && !entry.liveClaim) ||
      (entry.operationalStatus !== "live_verified" && entry.liveClaim)
    ) {
      fail("APPLICABILITY_STATE_STATUS_ERROR");
    }

    ids.add(entry.id);
    previousId = entry.id;
    states[entry.state] += 1;
    operationalStatuses[entry.operationalStatus] += 1;
  }

  for (const required of REQUIRED_INTEGRATIONS) {
    if (!ids.has(required)) {
      fail("APPLICABILITY_REQUIRED_INTEGRATION_MISSING");
    }
  }

  return {
    schemaVersion: 1,
    status: "pass",
    entryCount: registry.entries.length,
    states,
    operationalStatuses,
    liveClaimCount: registry.entries.filter((entry) => entry.liveClaim).length,
    requiredIntegrationCount: REQUIRED_INTEGRATIONS.size,
  };
}

async function readJson(file, code) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    fail(code);
  }
}

function parseArguments(argv) {
  let registry = DEFAULT_REGISTRY;
  let schema = DEFAULT_SCHEMA;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--registry" && index + 1 < argv.length) {
      registry = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argv[index] === "--schema" && index + 1 < argv.length) {
      schema = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    fail("APPLICABILITY_ARGUMENT_ERROR");
  }
  return { registry, schema };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const files = parseArguments(argv);
    const [registry, schema] = await Promise.all([
      readJson(files.registry, "APPLICABILITY_REGISTRY_READ_ERROR"),
      readJson(files.schema, "APPLICABILITY_SCHEMA_READ_ERROR"),
    ]);
    const result = validateRegistryObject(registry, schema);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: "fail", errorCode: error.code ?? "APPLICABILITY_VALIDATION_ERROR" })}\n`,
    );
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = await main();
}
