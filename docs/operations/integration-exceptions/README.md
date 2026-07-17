# Team Kit integration applicability and pending exceptions

Status: ORA-008 local decision record. No external integration, deployment,
repository access, routing key, or exception is represented as live or
approved by this document.

The machine-readable source of truth is
`config/team-kit-applicability/registry.json`. Its `state` is an architecture
disposition, not runtime evidence. `operationalStatus` and `liveClaim` prevent
an adopted or adapted pattern from being mistaken for an exercised service.

Allowed dispositions have precise meanings:

- `adopted`: the applicable Team Kit contract is mandatory without topology
  change;
- `adapted`: the contract is retained with an explicitly described assessment
  topology or safety change;
- `not_applicable`: the current Oracle mission does not contain the triggering
  surface; adding that surface reopens the decision;
- `exception_pending`: required access, ownership, data-handling approval, or
  an explicit assessment exception has not been verified. This is blocking to
  the release consequence named in the registry.

## Current Oracle decisions

| Capability | Decision | Operational truth | Rationale |
|---|---|---|---|
| Shared CI/CD | `adapted` | Not started; not live | Preserve the six-recipe interface, but the assessment pull-request workflow is validation-only. It receives no OIDC or provider secret and never deploys or publishes. |
| Lexicon | `exception_pending` | External access and change authority unverified | Team Kit requires every custom metric to be registered. A local catalog or placeholder entry would be false conformance. |
| Main Dashboard | `exception_pending` | External access and change authority unverified | Team Kit requires every custom metric to be visible. Local JSON and screenshots are not dashboard integration evidence. |
| PagerDuty | `exception_pending` | Service ownership, routing secret reference, and trigger/resolve proof unverified | Production critical failures must page and DLQ alarms must auto-resolve. A fake endpoint or placeholder key is prohibited. |
| AWS OIDC | `exception_pending` | Target role and repository trust unverified | Validation CI intentionally has no `id-token: write`. Any later automated deployment needs a separate least-privilege trust decision and deployment gate. |
| LangSmith | `exception_pending` | Compatibility, account, retention, region, and redaction unverified | Property prompts and tool evidence may include addresses or restricted ownership context; CloudWatch is not silently called an equivalent substitute. |
| Chat SDK and Asana state | `not_applicable` | Not used | Oracle has a web/API/MCP named-tool query agent, not an Asana-triggered chat surface. |
| AgentCore Memory | `not_applicable` | Not used | Oracle turns are immutable-release-bound queries; persistent conversational memory is not the system of record. |
| `build-frontend-backends` | `adapted` | Not started; not live | Keep shared TypeScript contracts, typed boundaries, CDK, and deployment verification while using the approved private S3 plus CloudFront host instead of the Amplify example topology. |
| Engineering guidelines | `adopted` | Not started; not live | Strict TypeScript service boundaries, CDK, tests, secret-safe observability, and explicit operational-integration dispositions remain mandatory. |

## Resolution evidence

An `exception_pending` entry can change only through one of two auditable paths:

1. integration evidence identifies the owner and target, proves access and
   least privilege, exercises the real integration without exposing secrets or
   restricted data, records test results, and updates the release gate; or
2. Ruslan explicitly approves a narrowly scoped assessment exception with
   rationale, compensating controls, affected claims, owner, and review/expiry
   point.

Neither path may be inferred from implementation approval, an environment
variable name, a placeholder, a local mock, Team Kit source inspection, or the
existence of an external repository. `exception_pending` remains pending until
the evidence is attached and the registry is updated through review.

## Release behavior

- Validation-only local and pull-request checks may proceed while external
  operational integrations are pending.
- The product must not claim unqualified Golden Path observability, shared
  deployment CI/CD, or Team Kit prompt-iteration conformance while the related
  entry is pending.
- Any runtime feature whose critical failure would otherwise be silent remains
  blocked from a production claim until PagerDuty is integrated or an explicit
  exception changes that exact boundary.
- Chat SDK and AgentCore Memory must not be stubbed for appearance. If their
  trigger arises later, their `not_applicable` decisions expire before code is
  added.

Run the registry validator and its mutation self-test with the pinned Node 22
binary:

```powershell
& 'E:\nvm\v22.18.0\node.exe' config/team-kit-applicability/validate.mjs
& 'E:\nvm\v22.18.0\node.exe' config/team-kit-applicability/self-test.mjs
```
