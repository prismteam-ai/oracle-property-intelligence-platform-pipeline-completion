# Elephant dependency reproduction

This guide validates and, in a later approved wave, reproduces the exact source
identities used by the Oracle assessment. It does not authorize a clone,
install, source copy, upstream edit, provider action, deployment, publication,
or redistribution.

## Boundary and files

- `config/dependencies/elephant-dependencies.lock.json` records six canonical
  repositories, full SHAs, ownership, legal states, exposure state, and drift
  behavior.
- `config/dependencies/dependency-lock.contract.json` is the machine-readable
  fail-closed policy.
- `config/dependencies/validate-dependency-lock.mts` validates the policy and
  lock with Node standard-library APIs only.
- `config/dependencies/validate-dependency-lock.self-test.mts` proves the valid
  path and intentionally invalid moving-ref, abbreviated-SHA, unknown-state,
  local-path, duplicate, missing-owner, and redistribution paths.

The active boundary is `exact_upstream_pin_plus_assessment_owned_adapter`.
All six sources are identity-only references in ORA-003: none is copied,
installed, or executed.

## Offline validation

From the repository root in PowerShell, use the required Node executable:

```powershell
& 'E:\nvm\v22.18.0\node.exe' '.\config\dependencies\validate-dependency-lock.mts'
```

Expected result:

```text
dependency-lock validation: PASS (6 sources)
```

Run the executable adversarial self-test:

```powershell
& 'E:\nvm\v22.18.0\node.exe' '.\config\dependencies\validate-dependency-lock.self-test.mts'
```

Expected result:

```text
dependency-lock self-test: PASS (13 cases)
```

For machine-readable validator output:

```powershell
& 'E:\nvm\v22.18.0\node.exe' '.\config\dependencies\validate-dependency-lock.mts' --json
```

These commands require no network, credentials, package installation, or
generated dependency directory. The self-test creates its temporary fixtures
under `config/dependencies` and verifies the resolved cleanup target remains
inside that directory before recursively removing it.

## Read-only drift re-verification

Drift verification is a separate, explicitly authorized read-only network
operation. Do not run it as part of the offline validation above. For each
record, run the exact `verificationCommand` stored in the lock, for example:

```text
git ls-remote --symref https://github.com/elephant-xyz/skills.git HEAD
```

Check both outputs:

1. symbolic `HEAD` still names the recorded `main` default branch;
2. the returned full `HEAD` SHA still equals `commitSha`.

The branch is observation metadata, never a consumption ref. If the branch or
head changes, retain the old exact pin, open a review, repeat dependency,
license, and capability checks, and create a reviewed lock change if the new
identity is intentionally adopted. Never edit only the SHA to make validation
green.

If an exact pinned commit becomes unreachable, block consumption and investigate
an approved reachable mirror or fork. Do not substitute a workstation checkout.

## Exact source checkout after later approval

When a later task explicitly authorizes source materialization, use a disposable
checkout and fetch the full SHA from the lock. The generic sequence is:

```text
git init <disposable-checkout>
git -C <disposable-checkout> remote add origin <canonical-https-url>
git -C <disposable-checkout> fetch --depth=1 origin <full-commit-sha>
git -C <disposable-checkout> checkout --detach <full-commit-sha>
git -C <disposable-checkout> rev-parse HEAD
```

The final value must equal both `commitSha` and `pinnedRef`. The disposable
checkout may be used to verify source bytes, license text, or compatibility,
but it must not become an application or build dependency by local path.
ORA-025 owns submission-reachable consumption and clean-room proof.

## License and redistribution gate

Commit identity does not confer a license. Before source or derived upstream
bytes are copied, patched, packaged, published, or redistributed:

1. inspect the exact pinned commit's license and notices;
2. record a verified or restricted license state and evidence;
3. classify the intended redistribution form;
4. obtain named approval authority and durable approval evidence when a
   redistribution claim is made;
5. rerun the validator.

The validator rejects a non-`none` redistribution claim unless the state is
`approved` and both approval fields are populated. ORA-003 intentionally leaves
all six sources at `not_approved` with claim `none`.

## Future modification forms

Use exactly one of these forms after its separate approval.

### Hash-bound vendored patch/apply manifest

The manifest must record:

- canonical upstream HTTPS URL;
- exact upstream base SHA;
- patch SHA-256;
- deterministic apply command;
- expected result-tree hash;
- approval evidence, including the license/redistribution decision.

The apply process must start from the exact base, fail on offset/reject/drift,
and verify the result-tree hash. An unbound `.patch` file is not sufficient.

### Approved reachable fork SHA

The manifest must record:

- canonical fork HTTPS URL;
- exact full fork commit SHA;
- exact upstream base SHA;
- base-relationship evidence;
- approval evidence, including the license/redistribution decision.

The fork commit must be reachable by a clean reviewer checkout. A branch name,
tag, unpushed local commit, or sibling worktree path is not acceptable.

## MCP compatibility warning

The unmodified `elephant-xyz/elephant-mcp` pin is retained for isolated ORA-026
compatibility evidence. Its direct `queryProperties` and `queryPermits`
caller-SQL executor is blocked. Do not expose or route evaluator requests to it
until ORA-069 certifies the approved replacement path. Named, typed, SQL-free
assessment evidence operations remain the primary authority.

## Failure recovery

- Validation failure: do not consume the lock; read every deterministic error,
  correct the source record or policy through review, and rerun both commands.
- Drift: keep the reviewed pin and open a repin decision; do not follow `main`.
- Missing license evidence: retain `not_verified_in_this_wave` and make no
  redistribution claim.
- Unreachable pin: block the dependency until an approved reachable source form
  exists.
- MCP caller-SQL request: return the blocked capability state and route only to
  the separately certified named or compatibility implementation.
