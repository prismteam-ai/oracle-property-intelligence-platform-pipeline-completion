#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRegistryObject } from "./validate.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
let assertions = 0;

function check(condition, code) {
  assertions += 1;
  if (!condition) {
    throw new Error(code);
  }
}

function expectRejected(registry, schema, code) {
  let rejected = false;
  try {
    validateRegistryObject(registry, schema);
  } catch {
    rejected = true;
  }
  check(rejected, code);
}

async function main() {
  try {
    const [registry, schema] = await Promise.all([
      fs.readFile(path.join(MODULE_DIRECTORY, "registry.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(MODULE_DIRECTORY, "schema.json"), "utf8").then(JSON.parse),
    ]);
    const valid = validateRegistryObject(registry, schema);
    check(valid.status === "pass" && valid.entryCount === registry.entries.length, "VALID_REGISTRY_REJECTED");
    check(valid.liveClaimCount === 0, "UNVERIFIED_LIVE_CLAIM");

    const invalidState = structuredClone(registry);
    invalidState.entries[0].state = "conditional";
    expectRejected(invalidState, schema, "INVALID_STATE_ACCEPTED");

    const missingState = structuredClone(registry);
    delete missingState.entries[0].state;
    expectRejected(missingState, schema, "MISSING_STATE_ACCEPTED");

    const twoStateFields = structuredClone(registry);
    twoStateFields.entries[0].states = ["not_applicable", "adapted"];
    expectRejected(twoStateFields, schema, "MULTIPLE_STATE_FIELDS_ACCEPTED");

    const duplicate = structuredClone(registry);
    duplicate.entries[1].id = duplicate.entries[0].id;
    expectRejected(duplicate, schema, "DUPLICATE_ID_ACCEPTED");

    const falseLive = structuredClone(registry);
    const pending = falseLive.entries.find((entry) => entry.state === "exception_pending");
    pending.operationalStatus = "live_verified";
    pending.liveClaim = true;
    expectRejected(falseLive, schema, "PENDING_LIVE_CLAIM_ACCEPTED");

    const missingRequired = structuredClone(registry);
    missingRequired.entries = missingRequired.entries.filter((entry) => entry.id !== "pagerduty");
    expectRejected(missingRequired, schema, "MISSING_REQUIRED_INTEGRATION_ACCEPTED");

    const unsorted = structuredClone(registry);
    [unsorted.entries[0], unsorted.entries[1]] = [unsorted.entries[1], unsorted.entries[0]];
    expectRejected(unsorted, schema, "UNSORTED_REGISTRY_ACCEPTED");

    const schemaDrift = structuredClone(schema);
    schemaDrift.$defs.entry.properties.state.enum.push("conditional");
    expectRejected(registry, schemaDrift, "SCHEMA_STATE_DRIFT_ACCEPTED");

    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "pass", assertions })}\n`);
    return 0;
  } catch (error) {
    const errorCode = /^[A-Z0-9_]+$/.test(error.message) ? error.message : "APPLICABILITY_SELF_TEST_ERROR";
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "fail", errorCode })}\n`);
    return 1;
  }
}

process.exitCode = await main();
