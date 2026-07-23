# Credential ingress and rotation

Status: ORA-006 local safety contract. This document authorizes no credential
read, provider action, deployment, publication, or CI secret configuration.

## Boundary

Repository source, examples, logs, test output, assessment evidence, demo
artifacts, and public data artifacts must contain no credential value. The
workspace-root `.config` tree is outside this repository's trust boundary: the
repository scanner and ingress tooling neither crawl nor accept it.

The only supported ingress paths are:

1. an operator-managed AWS profile selector for local bootstrap work;
2. runtime injection from an approved secret store into the exact process that
   needs a non-AWS provider secret; or
3. one explicit, untracked, Git-ignored local environment file for a bounded
   local operation when a secret-store injection path is unavailable.

Static AWS access keys, administrator exports, access-key CSV files, direct LLM
provider keys, PagerDuty routing keys, and CI personal access tokens are not
accepted by the file ingress contract. The supplied administrator identity is
bootstrap-only and must not become an application, deployment, or CI identity.

## Operator procedure

Before any account-bound work:

1. Run `tools/secret-policy/self-test.mjs` with the pinned Node 22 binary.
2. Run `tools/secret-policy/scan.mjs --repo . --format text`; require exit `0`.
3. Resolve the exact task approval, provider, account, region, purpose, minimum
   variables, expiry, and cleanup owner. Do not infer one gate from another.
4. For AWS, import or select credentials through the operator's approved
   credential manager outside the repository, then provide only the profile
   name through `AWS_PROFILE`. Verify account and region without echoing any
   credential field.
5. For a secret-store-backed runtime, inject only the named variables from
   `tools/secret-policy/ingress-variables.json` into the bounded process.
6. If a local file is explicitly approved, create `.env.local` inside this
   repository. Confirm `git check-ignore .env.local` succeeds and never stage
   the file.
7. Validate the local file with
   `tools/secret-policy/validate-ingress.mjs --repo . --file .env.local`.
   The result lists variable names and classifications only.
8. Invoke only the approved operation. Application code may consume the
   non-enumerable `environment` object returned by `loadCredentialEnvironment`;
   it must not serialize, log, persist, or attach that object to errors.
9. Remove the local file when the bounded work finishes, revoke or rotate any
   temporary secret, and rerun the repository scan.

The repository ignore boundary also covers root-local provider `*.env` files,
`.config/`, `.aws/`, `token.json`, and `.npmrc`. This prevents ordinary adds and
the Git-visible scanner from opening those local credential containers. It is
not an allowlist: `git add -f` or a previously tracked prohibited path remains
enumerated and is rejected by filename before any content read. `.env.example`
is deliberately visible and must contain placeholders only.

There is intentionally no general-purpose command runner in the ingress tool.
Suppressing or redacting arbitrary child-process output cannot guarantee that a
child will not transform and reveal a secret. Each account-bound adapter must
own its typed environment projection and logging policy.

## Failure handling

The operation must stop on any of these conditions:

- repository identity cannot be proven;
- a credential file is tracked, unignored, outside the repository, a symlink,
  or beneath a `.config` component;
- a variable is unknown, duplicated, forbidden, empty, or still a placeholder;
- the scanner reports a prohibited path, provider pattern, or operational
  error;
- the target account, region, role, capability, or approval differs from the
  bound task record.

Scanner and ingress diagnostics contain rule/error identifiers and sanitized
paths only. They must never be “improved” by adding matching lines, snippets,
values, environment dumps, command environments, provider payloads, or raw
exception objects.

## Incident response

If a real value may have entered Git, logs, an artifact, a demo, or a public
endpoint:

1. stop publication and deployment work;
2. revoke or rotate the value at its provider;
3. preserve a value-free incident record with provider, credential class,
   affected artifact IDs, time window, owner, and rotation evidence;
4. remove the value from every reachable artifact through an explicitly
   approved history/artifact remediation plan;
5. rerun local and hosted secret scanning before resuming.

Deleting the working-tree file alone is not remediation after a value was
committed, uploaded, logged, or published.
