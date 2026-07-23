#!/usr/bin/env node
// Compute the Oracle agent semantic policy hash from a serving-config.json.
//
// Usage:
//   node tools/semantic-policy-hash.mjs <path-to-serving-config.json>
//
// The printed value is `sha256:<hex>` and is consumed as a deployed CDK context
// value. It is derived by @oracle/agent's createProductionAgentSemanticPolicy,
// which canonicalizes the named-evidence tool JSON schemas, the per-tool
// capability gating derived from `capabilities`, the support-state vocabulary,
// the data dictionary, and the prompt policy, then SHA-256s that canonical
// string. This tool deliberately does NOT reimplement that algorithm: it calls
// the package so the deployed hash and the runtime hash cannot diverge.
//
// Requires `packages/agent` to have been built (dist/index.js present).

import { readFile } from 'node:fs/promises';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AGENT_ENTRY_URL = new URL('../packages/agent/dist/index.js', import.meta.url);

class PolicyHashError extends Error {}

async function loadAgentModule() {
  try {
    return await import(AGENT_ENTRY_URL.href);
  } catch (cause) {
    throw new PolicyHashError(
      `Cannot load @oracle/agent from ${fileURLToPath(AGENT_ENTRY_URL)}. ` +
        `Build the package first (pnpm --filter @oracle/agent build). Underlying error: ${cause.message}`,
    );
  }
}

async function readServingConfig(configPath) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (cause) {
    throw new PolicyHashError(`Cannot read serving config at ${configPath}: ${cause.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new PolicyHashError(`Serving config at ${configPath} is not valid JSON: ${cause.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PolicyHashError(`Serving config at ${configPath} must be a JSON object.`);
  }
  const { capabilities } = parsed;
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new PolicyHashError(
      `Serving config at ${configPath} has no usable "capabilities" object; ` +
        `cannot compute a semantic policy hash from it.`,
    );
  }
  return capabilities;
}

/**
 * Compute the semantic policy hash for a serving config on disk.
 * @param {string} configPath Path to a serving-config.json.
 * @returns {Promise<string>} `sha256:<hex>`
 */
export async function computeSemanticPolicyHash(configPath) {
  if (typeof configPath !== 'string' || configPath.trim() === '') {
    throw new PolicyHashError('A serving-config.json path is required.');
  }
  const [agent, capabilities] = await Promise.all([
    loadAgentModule(),
    readServingConfig(configPath),
  ]);
  if (typeof agent.createProductionAgentSemanticPolicy !== 'function') {
    throw new PolicyHashError(
      `@oracle/agent does not export createProductionAgentSemanticPolicy; the tool is out of date with the package.`,
    );
  }
  const policy = agent.createProductionAgentSemanticPolicy(capabilities);
  if (typeof policy?.hash !== 'string' || !policy.hash.startsWith('sha256:')) {
    throw new PolicyHashError(
      `createProductionAgentSemanticPolicy returned no sha256 hash (got ${JSON.stringify(policy?.hash)}).`,
    );
  }
  return policy.hash;
}

async function main() {
  const configPath = argv[2];
  if (configPath === undefined) {
    stderr.write(`usage: node tools/semantic-policy-hash.mjs <path-to-serving-config.json>\n`);
    exit(2);
  }
  try {
    stdout.write(`${await computeSemanticPolicyHash(configPath)}\n`);
  } catch (error) {
    stderr.write(
      `FATAL semantic-policy-hash: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    exit(1);
  }
}

// Run main() only when executed directly, not when imported by the unit test.
if (argv[1] !== undefined && pathToFileURL(argv[1]).href === import.meta.url) {
  await main();
}
