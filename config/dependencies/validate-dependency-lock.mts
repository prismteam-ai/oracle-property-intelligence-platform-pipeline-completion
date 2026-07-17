import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

export type ValidationResult = {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly sourceCount: number;
};

type CliOptions = {
  readonly lockPath: string;
  readonly contractPath: string;
  readonly json: boolean;
  readonly help: boolean;
};

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCK_PATH = join(HERE, "elephant-dependencies.lock.json");
export const DEFAULT_CONTRACT_PATH = join(HERE, "dependency-lock.contract.json");

const CONTRACT_ROOT_KEYS = [
  "contractVersion",
  "lockSchemaVersion",
  "lockId",
  "expectedSourceCount",
  "requiredRepositories",
  "shapes",
  "identityRules",
  "allowedStates",
  "redistributionRules",
  "futureModificationRules",
] as const;

const SHAPES = {
  lock: ["schemaVersion", "lockId", "verification", "boundary", "sources"],
  verification: ["observedAt", "method", "evidenceId", "networkAccessInThisWave"],
  boundary: [
    "activeState",
    "currentWaveState",
    "assessmentAdapterOwner",
    "upstreamSourceCopied",
    "upstreamSourceInstalled",
    "upstreamSourceExecuted",
    "futureModificationForms",
    "prohibitedForms",
  ],
  futureModificationForm: ["kind", "requirements"],
  source: [
    "repository",
    "canonicalUrl",
    "observedDefaultBranch",
    "commitSha",
    "pinnedRef",
    "intendedUse",
    "consumptionMode",
    "dependencyState",
    "materializationState",
    "ownershipBoundary",
    "license",
    "redistribution",
    "securityExposure",
    "verificationCommand",
    "driftPolicy",
  ],
  ownershipBoundary: [
    "state",
    "upstreamOwner",
    "assessmentIntegrationOwner",
    "modificationBoundary",
    "upstreamRuntimeResourcesAssumed",
  ],
  license: ["state", "identifier", "evidence"],
  redistribution: ["state", "claim", "approvalAuthority", "approvalEvidence"],
  securityExposure: ["state", "note"],
  driftPolicy: [
    "state",
    "defaultBranchHeadChange",
    "pinnedCommitUnavailable",
    "lockUpdate",
  ],
} as const;

const ALLOWED_STATES = {
  boundary: ["exact_upstream_pin_plus_assessment_owned_adapter"],
  currentWave: ["identity_only_no_materialization"],
  dependency: ["identity_locked"],
  consumption: ["exact_pin_reference_for_assessment_owned_adapter"],
  materialization: ["not_copied_installed_or_executed"],
  ownership: ["explicit_split"],
  license: ["not_verified_in_this_wave", "verified", "restricted"],
  redistribution: ["not_approved", "approved", "prohibited"],
  redistributionClaim: ["none", "source_copy", "binary_distribution", "patch_distribution"],
  exposure: ["not_runtime_exposed", "compatibility_evidence_only_caller_sql_blocked"],
  drift: ["fail_closed"],
} as const;

const IDENTITY_RULES = {
  repositoryPattern: "^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$",
  fullShaPattern: "^[0-9a-f]{40}$",
  canonicalUrlTemplate: "https://github.com/{repository}.git",
  observedDefaultBranch: "main",
  verificationCommandTemplate: "git ls-remote --symref {canonicalUrl} HEAD",
} as const;

const FUTURE_MODIFICATION_FORMS = {
  hash_bound_vendored_patch_apply_manifest: [
    "canonicalHttpsUrl",
    "exactUpstreamBaseSha",
    "patchSha256",
    "deterministicApplyCommand",
    "resultTreeHash",
    "approvalEvidence",
  ],
  approved_reachable_fork_sha: [
    "canonicalHttpsUrl",
    "fullCommitSha",
    "exactUpstreamBaseSha",
    "baseRelationshipEvidence",
    "approvalEvidence",
  ],
} as const;

const PROHIBITED_FORMS = [
  "moving_branch_ref",
  "moving_tag_ref",
  "workstation_path",
  "unhashed_patch",
  "unapproved_source_copy",
  "unreachable_fork_commit",
] as const;

const REQUIRED_REPOSITORIES = [
  "elephant-xyz/skills",
  "elephant-xyz/oracle-node",
  "elephant-xyz/elephant-query-db",
  "elephant-xyz/Counties-trasform-scripts",
  "elephant-xyz/elephant-cli",
  "elephant-xyz/elephant-mcp",
] as const;

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_PATH_PATTERN = /^(?:file:|[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~[\\/])/i;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function arraysEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  path: string,
  errors: string[],
): value is JsonObject {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }

  const actualKeys = Object.keys(value);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  }
  for (const key of actualKeys.sort()) {
    if (!expectedKeys.includes(key)) errors.push(`${path}.${key} is not allowed`);
  }
  return true;
}

function assertExactStringArray(
  value: unknown,
  expected: readonly string[],
  path: string,
  errors: string[],
): void {
  const actual = readStringArray(value);
  if (actual === null) {
    errors.push(`${path} must be an array of strings`);
    return;
  }
  if (!arraysEqual(actual, expected)) {
    errors.push(`${path} must exactly equal [${expected.join(", ")}]`);
  }
}

function assertState(
  value: unknown,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${path} has unrecognized state ${JSON.stringify(value)}; allowed: ${allowed.join(", ")}`);
  }
}

function assertNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (!isNonEmptyString(value)) errors.push(`${path} must be a non-empty string`);
}

function validateContract(contract: unknown): readonly string[] {
  const errors: string[] = [];
  if (!assertExactKeys(contract, CONTRACT_ROOT_KEYS, "contract", errors)) return errors;

  if (contract.contractVersion !== 1) errors.push("contract.contractVersion must equal 1");
  if (contract.lockSchemaVersion !== 1) errors.push("contract.lockSchemaVersion must equal 1");
  if (contract.lockId !== "oracle-elephant-upstreams") {
    errors.push('contract.lockId must equal "oracle-elephant-upstreams"');
  }
  if (contract.expectedSourceCount !== REQUIRED_REPOSITORIES.length) {
    errors.push(`contract.expectedSourceCount must equal ${REQUIRED_REPOSITORIES.length}`);
  }
  assertExactStringArray(
    contract.requiredRepositories,
    REQUIRED_REPOSITORIES,
    "contract.requiredRepositories",
    errors,
  );

  if (assertExactKeys(contract.shapes, Object.keys(SHAPES), "contract.shapes", errors)) {
    for (const [name, expected] of Object.entries(SHAPES)) {
      assertExactStringArray(contract.shapes[name], expected, `contract.shapes.${name}`, errors);
    }
  }

  if (
    assertExactKeys(
      contract.identityRules,
      Object.keys(IDENTITY_RULES),
      "contract.identityRules",
      errors,
    )
  ) {
    for (const [name, expected] of Object.entries(IDENTITY_RULES)) {
      if (contract.identityRules[name] !== expected) {
        errors.push(`contract.identityRules.${name} must equal ${JSON.stringify(expected)}`);
      }
    }
  }

  if (
    assertExactKeys(
      contract.allowedStates,
      Object.keys(ALLOWED_STATES),
      "contract.allowedStates",
      errors,
    )
  ) {
    for (const [name, expected] of Object.entries(ALLOWED_STATES)) {
      assertExactStringArray(
        contract.allowedStates[name],
        expected,
        `contract.allowedStates.${name}`,
        errors,
      );
    }
  }

  if (
    assertExactKeys(
      contract.redistributionRules,
      [
        "noClaimValue",
        "approvedState",
        "approvalFields",
        "approvalEvidenceRequiredWhenClaimed",
        "identityDoesNotConferPermission",
      ],
      "contract.redistributionRules",
      errors,
    )
  ) {
    if (contract.redistributionRules.noClaimValue !== "none") {
      errors.push('contract.redistributionRules.noClaimValue must equal "none"');
    }
    if (contract.redistributionRules.approvedState !== "approved") {
      errors.push('contract.redistributionRules.approvedState must equal "approved"');
    }
    assertExactStringArray(
      contract.redistributionRules.approvalFields,
      ["approvalAuthority", "approvalEvidence"],
      "contract.redistributionRules.approvalFields",
      errors,
    );
    if (contract.redistributionRules.approvalEvidenceRequiredWhenClaimed !== true) {
      errors.push("contract.redistributionRules.approvalEvidenceRequiredWhenClaimed must be true");
    }
    if (contract.redistributionRules.identityDoesNotConferPermission !== true) {
      errors.push("contract.redistributionRules.identityDoesNotConferPermission must be true");
    }
  }

  if (
    assertExactKeys(
      contract.futureModificationRules,
      ["requiredForms", "prohibitedForms"],
      "contract.futureModificationRules",
      errors,
    )
  ) {
    if (
      assertExactKeys(
        contract.futureModificationRules.requiredForms,
        Object.keys(FUTURE_MODIFICATION_FORMS),
        "contract.futureModificationRules.requiredForms",
        errors,
      )
    ) {
      for (const [kind, requirements] of Object.entries(FUTURE_MODIFICATION_FORMS)) {
        assertExactStringArray(
          contract.futureModificationRules.requiredForms[kind],
          requirements,
          `contract.futureModificationRules.requiredForms.${kind}`,
          errors,
        );
      }
    }
    assertExactStringArray(
      contract.futureModificationRules.prohibitedForms,
      PROHIBITED_FORMS,
      "contract.futureModificationRules.prohibitedForms",
      errors,
    );
  }

  return errors;
}

function validateVerification(value: unknown, errors: string[]): void {
  if (!assertExactKeys(value, SHAPES.verification, "lock.verification", errors)) return;
  if (typeof value.observedAt !== "string" || !ISO_DATE_PATTERN.test(value.observedAt)) {
    errors.push("lock.verification.observedAt must be an ISO date (YYYY-MM-DD)");
  }
  if (value.method !== "git_ls_remote_symref_head") {
    errors.push('lock.verification.method must equal "git_ls_remote_symref_head"');
  }
  assertNonEmptyString(value.evidenceId, "lock.verification.evidenceId", errors);
  if (value.networkAccessInThisWave !== false) {
    errors.push("lock.verification.networkAccessInThisWave must be false for ORA-003");
  }
}

function validateBoundary(value: unknown, errors: string[]): void {
  if (!assertExactKeys(value, SHAPES.boundary, "lock.boundary", errors)) return;

  assertState(value.activeState, ALLOWED_STATES.boundary, "lock.boundary.activeState", errors);
  assertState(
    value.currentWaveState,
    ALLOWED_STATES.currentWave,
    "lock.boundary.currentWaveState",
    errors,
  );
  assertNonEmptyString(value.assessmentAdapterOwner, "lock.boundary.assessmentAdapterOwner", errors);

  for (const field of ["upstreamSourceCopied", "upstreamSourceInstalled", "upstreamSourceExecuted"]) {
    if (value[field] !== false) errors.push(`lock.boundary.${field} must be false in ORA-003`);
  }

  if (!Array.isArray(value.futureModificationForms)) {
    errors.push("lock.boundary.futureModificationForms must be an array");
  } else {
    const seen = new Set<string>();
    for (const [index, form] of value.futureModificationForms.entries()) {
      const path = `lock.boundary.futureModificationForms[${index}]`;
      if (!assertExactKeys(form, SHAPES.futureModificationForm, path, errors)) continue;
      if (!isNonEmptyString(form.kind) || !Object.hasOwn(FUTURE_MODIFICATION_FORMS, form.kind)) {
        errors.push(`${path}.kind is unrecognized`);
        continue;
      }
      if (seen.has(form.kind)) errors.push(`${path}.kind duplicates ${form.kind}`);
      seen.add(form.kind);
      const requirements = FUTURE_MODIFICATION_FORMS[
        form.kind as keyof typeof FUTURE_MODIFICATION_FORMS
      ];
      assertExactStringArray(form.requirements, requirements, `${path}.requirements`, errors);
    }
    for (const kind of Object.keys(FUTURE_MODIFICATION_FORMS)) {
      if (!seen.has(kind)) errors.push(`lock.boundary.futureModificationForms is missing ${kind}`);
    }
  }

  assertExactStringArray(
    value.prohibitedForms,
    PROHIBITED_FORMS,
    "lock.boundary.prohibitedForms",
    errors,
  );
}

function validateOwnership(value: unknown, path: string, repository: string, errors: string[]): void {
  if (!assertExactKeys(value, SHAPES.ownershipBoundary, path, errors)) return;
  assertState(value.state, ALLOWED_STATES.ownership, `${path}.state`, errors);
  const expectedUpstreamOwner = repository.split("/", 1)[0];
  if (value.upstreamOwner !== expectedUpstreamOwner) {
    errors.push(`${path}.upstreamOwner must equal repository owner ${JSON.stringify(expectedUpstreamOwner)}`);
  }
  assertNonEmptyString(value.assessmentIntegrationOwner, `${path}.assessmentIntegrationOwner`, errors);
  if (value.modificationBoundary !== "assessment_owned_adapter") {
    errors.push(`${path}.modificationBoundary must equal "assessment_owned_adapter"`);
  }
  if (value.upstreamRuntimeResourcesAssumed !== false) {
    errors.push(`${path}.upstreamRuntimeResourcesAssumed must be false`);
  }
}

function validateLicense(value: unknown, path: string, errors: string[]): void {
  if (!assertExactKeys(value, SHAPES.license, path, errors)) return;
  assertState(value.state, ALLOWED_STATES.license, `${path}.state`, errors);
  assertNonEmptyString(value.evidence, `${path}.evidence`, errors);

  if (value.state === "not_verified_in_this_wave" && value.identifier !== null) {
    errors.push(`${path}.identifier must be null when license state is not verified`);
  }
  if ((value.state === "verified" || value.state === "restricted") && !isNonEmptyString(value.identifier)) {
    errors.push(`${path}.identifier must be populated when license state is ${value.state}`);
  }
}

function validateRedistribution(value: unknown, path: string, errors: string[]): void {
  if (!assertExactKeys(value, SHAPES.redistribution, path, errors)) return;
  assertState(value.state, ALLOWED_STATES.redistribution, `${path}.state`, errors);
  assertState(value.claim, ALLOWED_STATES.redistributionClaim, `${path}.claim`, errors);

  const claimsRedistribution = value.claim !== "none";
  if (claimsRedistribution && value.state !== "approved") {
    errors.push(`${path} makes an unapproved redistribution claim`);
  }
  if (value.state === "approved" && !claimsRedistribution) {
    errors.push(`${path}.claim must identify the approved redistribution form`);
  }

  if (value.state === "approved" || claimsRedistribution) {
    assertNonEmptyString(value.approvalAuthority, `${path}.approvalAuthority`, errors);
    assertNonEmptyString(value.approvalEvidence, `${path}.approvalEvidence`, errors);
  } else {
    if (value.approvalAuthority !== null) {
      errors.push(`${path}.approvalAuthority must be null without approved redistribution`);
    }
    if (value.approvalEvidence !== null) {
      errors.push(`${path}.approvalEvidence must be null without approved redistribution`);
    }
  }
}

function validateSecurityExposure(
  value: unknown,
  path: string,
  repository: string,
  errors: string[],
): void {
  if (!assertExactKeys(value, SHAPES.securityExposure, path, errors)) return;
  assertState(value.state, ALLOWED_STATES.exposure, `${path}.state`, errors);
  assertNonEmptyString(value.note, `${path}.note`, errors);

  const expected = repository === "elephant-xyz/elephant-mcp"
    ? "compatibility_evidence_only_caller_sql_blocked"
    : "not_runtime_exposed";
  if (value.state !== expected) {
    errors.push(`${path}.state must equal ${JSON.stringify(expected)} for ${repository}`);
  }
}

function validateDriftPolicy(value: unknown, path: string, errors: string[]): void {
  if (!assertExactKeys(value, SHAPES.driftPolicy, path, errors)) return;
  assertState(value.state, ALLOWED_STATES.drift, `${path}.state`, errors);
  const expected = {
    defaultBranchHeadChange: "open_review_and_repin",
    pinnedCommitUnavailable: "block_consumption",
    lockUpdate: "review_new_exact_identity",
  } as const;
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue) {
      errors.push(`${path}.${field} must equal ${JSON.stringify(expectedValue)}`);
    }
  }
}

function validateSource(
  value: unknown,
  index: number,
  seenRepositories: Set<string>,
  errors: string[],
): void {
  const path = `lock.sources[${index}]`;
  if (!assertExactKeys(value, SHAPES.source, path, errors)) return;

  const repository = typeof value.repository === "string" ? value.repository : "";
  if (!REPOSITORY_PATTERN.test(repository)) {
    errors.push(`${path}.repository is not a canonical owner/repository identity`);
  }
  const repositoryKey = repository.toLowerCase();
  if (repositoryKey.length > 0 && seenRepositories.has(repositoryKey)) {
    errors.push(`${path}.repository duplicates ${JSON.stringify(repository)}`);
  }
  seenRepositories.add(repositoryKey);

  if (typeof value.canonicalUrl === "string" && LOCAL_PATH_PATTERN.test(value.canonicalUrl)) {
    errors.push(`${path}.canonicalUrl must not be a local-path dependency`);
  }
  const expectedUrl = `https://github.com/${repository}.git`;
  if (value.canonicalUrl !== expectedUrl) {
    errors.push(`${path}.canonicalUrl must equal ${JSON.stringify(expectedUrl)}`);
  }
  if (value.observedDefaultBranch !== IDENTITY_RULES.observedDefaultBranch) {
    errors.push(`${path}.observedDefaultBranch must equal "main"`);
  }

  if (typeof value.commitSha !== "string" || !FULL_SHA_PATTERN.test(value.commitSha)) {
    errors.push(`${path}.commitSha must be an exact 40-character lowercase SHA`);
  }
  if (typeof value.pinnedRef !== "string" || !FULL_SHA_PATTERN.test(value.pinnedRef)) {
    errors.push(`${path}.pinnedRef must be an exact 40-character lowercase SHA, not a moving ref`);
  }
  if (value.commitSha !== value.pinnedRef) {
    errors.push(`${path}.pinnedRef must equal commitSha`);
  }

  assertNonEmptyString(value.intendedUse, `${path}.intendedUse`, errors);
  assertState(value.consumptionMode, ALLOWED_STATES.consumption, `${path}.consumptionMode`, errors);
  assertState(value.dependencyState, ALLOWED_STATES.dependency, `${path}.dependencyState`, errors);
  assertState(
    value.materializationState,
    ALLOWED_STATES.materialization,
    `${path}.materializationState`,
    errors,
  );

  validateOwnership(value.ownershipBoundary, `${path}.ownershipBoundary`, repository, errors);
  validateLicense(value.license, `${path}.license`, errors);
  validateRedistribution(value.redistribution, `${path}.redistribution`, errors);
  validateSecurityExposure(value.securityExposure, `${path}.securityExposure`, repository, errors);

  const expectedVerificationCommand = `git ls-remote --symref ${expectedUrl} HEAD`;
  if (value.verificationCommand !== expectedVerificationCommand) {
    errors.push(`${path}.verificationCommand must equal ${JSON.stringify(expectedVerificationCommand)}`);
  }
  validateDriftPolicy(value.driftPolicy, `${path}.driftPolicy`, errors);
}

export function validateDependencyLock(lock: unknown, contract: unknown): ValidationResult {
  const contractErrors = validateContract(contract);
  if (contractErrors.length > 0) {
    return {
      ok: false,
      errors: contractErrors.map((error) => `contract invalid: ${error}`),
      sourceCount: 0,
    };
  }

  const errors: string[] = [];
  if (!assertExactKeys(lock, SHAPES.lock, "lock", errors)) {
    return { ok: false, errors, sourceCount: 0 };
  }

  if (lock.schemaVersion !== 1) errors.push("lock.schemaVersion must equal 1");
  if (lock.lockId !== "oracle-elephant-upstreams") {
    errors.push('lock.lockId must equal "oracle-elephant-upstreams"');
  }
  validateVerification(lock.verification, errors);
  validateBoundary(lock.boundary, errors);

  let sourceCount = 0;
  if (!Array.isArray(lock.sources)) {
    errors.push("lock.sources must be an array");
  } else {
    sourceCount = lock.sources.length;
    if (sourceCount !== REQUIRED_REPOSITORIES.length) {
      errors.push(`lock.sources must contain exactly ${REQUIRED_REPOSITORIES.length} records`);
    }
    const seenRepositories = new Set<string>();
    lock.sources.forEach((source, index) => validateSource(source, index, seenRepositories, errors));

    const present = new Set(
      lock.sources
        .filter(isPlainObject)
        .map((source) => source.repository)
        .filter((repository): repository is string => typeof repository === "string"),
    );
    for (const repository of REQUIRED_REPOSITORIES) {
      if (!present.has(repository)) errors.push(`lock.sources is missing required repository ${repository}`);
    }
    for (const repository of [...present].sort()) {
      if (!REQUIRED_REPOSITORIES.includes(repository as (typeof REQUIRED_REPOSITORIES)[number])) {
        errors.push(`lock.sources contains unrecognized repository ${repository}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, sourceCount };
}

export async function readJsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${detail}`);
  }
}

export async function validateDependencyLockFiles(
  lockPath = DEFAULT_LOCK_PATH,
  contractPath = DEFAULT_CONTRACT_PATH,
): Promise<ValidationResult> {
  const [lock, contract] = await Promise.all([readJsonFile(lockPath), readJsonFile(contractPath)]);
  return validateDependencyLock(lock, contract);
}

function parseCliArguments(args: readonly string[]): CliOptions {
  let lockPath = DEFAULT_LOCK_PATH;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let json = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--lock" || argument === "--contract") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a path`);
      if (argument === "--lock") lockPath = resolve(value);
      else contractPath = resolve(value);
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { lockPath, contractPath, json, help };
}

function helpText(): string {
  return [
    "Usage: node validate-dependency-lock.mts [options]",
    "",
    "Options:",
    "  --lock <path>      Validate a different lock fixture",
    "  --contract <path>  Validate against a different contract fixture",
    "  --json             Emit a deterministic JSON result",
    "  -h, --help         Show this help",
    "",
  ].join("\n");
}

async function runCli(): Promise<number> {
  const options = parseCliArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }

  const result = await validateDependencyLockFiles(options.lockPath, options.contractPath);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`dependency-lock validation: PASS (${result.sourceCount} sources)\n`);
  } else {
    process.stderr.write(
      `dependency-lock validation: FAIL (${result.errors.length} errors)\n${result.errors
        .map((error) => `- ${error}`)
        .join("\n")}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]).toLowerCase();
const modulePath = resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invokedPath === modulePath) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`dependency-lock validation: ERROR\n- ${detail}\n`);
      process.exitCode = 2;
    });
}
