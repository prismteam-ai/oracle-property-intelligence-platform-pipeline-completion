# Oracle Bedrock named-tool agent

This package implements the Wave 3A Oracle agent as a Vercel AI SDK
`ToolLoopAgent` over exactly one Amazon Bedrock model. It has no provider
registry, default model, rules-engine answer path, canned success response, or
silent fallback.

## Runtime boundary

The agent receives only the sixteen frozen, SQL-free named evidence functions.
Production composes `oracle-agent-serving@1.0.0` over the same verified
`ProductionServingService` used by API and MCP. The adapter injects the
server-owned immutable release, verifies an optional matching tool release,
translates only explicit contract fields, and fails closed on an unknown tool,
field, release, policy, or response shape.

The serving envelope keeps schema version `1.0.0`; the adapter version is a
separate literal. `get_dataset_info` validates release continuity but calls the
serving discovery operation without a release input. Other operations receive
the exact verified release ID. Fixed policy fields—complete ownership history,
current regional owner, 200 m snap distance, 0.7 place confidence, the six
immutable ranking weights, and public artifact visibility—are server-owned and
cannot be overridden by the model.

Operation-specific evidence is removed from nested result payloads, normalized
into one top-level public evidence envelope, deduplicated, sorted, and limited.
The redaction boundary rejects restricted owner/contact data, SQL/query
authority, credentials, raw fields, physical paths, buckets/object keys,
connections, and network locators before anything reaches the model.

## Required configuration

Production composition must provide all of these values explicitly:

- `ORACLE_MODEL_PROVIDER=amazon-bedrock`
- `ORACLE_BEDROCK_MODEL_ID=<exact promoted model or inference profile ID>`
- `ORACLE_BEDROCK_REGION=us-east-1|us-east-2`
- `ORACLE_AGENT_POLICY_HASH=sha256:<semantic-policy hash>`

There are no defaults. AWS runtime identity supplies credentials; code and logs
must never print them.

The semantic policy hash is generated deterministically from the sixteen JSON
schemas, release capabilities, support vocabulary, safe data dictionary, and
prompt policy. Any drift blocks startup. Promotion evidence must bind this hash
to the exact Bedrock profile.

## Bounds and fidelity

- graded criterion inquiries use a deterministic request classifier to execute
  the threshold-bearing named inquiry before synthesis; an explicit two-signal
  conjunction first reads a bounded page of at most 5 primary candidates, then
  checks the second predicate for each exact `propertyId` with `limit: 1` and
  intersects only rows with `supported` or `proxy` evidence bound to that
  property for every predicate, while an explicit ranking request uses the
  combined ranking inquiry;
- the model receives the bounded validated evidence results with no tools and
  performs exactly one synthesis request that must return a strict JSON claim
  envelope with no free-form prose; for a conjunction it receives only the
  final proven intersection and its evidence, never the nonmatching rows;
  metadata and ambiguous requests retain the bounded tool loop, with at most 3
  model steps and 6 tool calls;
- runtime validation requires the structured claim set to equal the proven
  property set and binds every predicate citation to its exact property and
  tool. Swapped, unattached, duplicated, dumped, omitted-property, extra-prose,
  or scope-mismatched output fails closed. Only after validation does a
  deterministic renderer produce the natural-language answer and citations;
- one non-normalizing property-ID schema is enforced on raw tool output before
  envelope parsing, on evidence rows/references, on structured model claims,
  and before rendering. It accepts canonical `sc:entity:property:<stable-key>`
  IDs, the existing safe `sc:property:<stable-key>` serving form, safe
  `property-<stable-key>` fixture IDs, and normalized APNs; controls, whitespace,
  brackets, citation syntax, Unicode normalization changes, and conflicting
  aliases fail rather than being trimmed or rewritten;
- conjunction results are exact for the returned primary candidate page but are
  not represented as county-exhaustive; source truncation and the 5-row primary
  bound remain explicit in the synthesis payload and are enforced again during
  answer validation;
- at most 768 output tokens and 5 rows per deterministic inquiry synthesis;
- at most 48 KiB of exact named-tool evidence and 64 KiB for the complete
  synthesis prompt, including framing, user question, and evidence;
- a 24-second total timeout and 20-second per-step timeout, nested inside the
  25-second API request budget, 29-second API Gateway integration, and 30-second
  Lambda boundary; the total timer starts before every prefetch and therefore
  includes all concurrent evidence work plus model synthesis;
- zero provider retries: each model step issues exactly one request, with no
  model/profile fallback;
- user questions at most 8,000 characters; deterministic synthesis is governed
  separately by the stricter complete-prompt byte ceiling above;
- tool envelopes at most 900 KiB, 100 returned rows, and 1,000 evidence references;
- each analytical call at most 5 seconds and 512 MiB scanned;
- exact immutable release binding;
- returned property facts require `[evidence:<returned ID>]` citations;
- each conjunction match requires at least one citation from every positive
  property-bound predicate evidence set; fabricated IDs, incomplete predicate
  citations, erased unknown/unsupported states, contradictory empty-result
  prose, and county-exhaustive claims cannot enter the typed envelope or the
  deterministic rendered answer;
- prefetch failure aborts peer property predicates, makes zero provider
  requests, and returns a named-evidence failure; dependency/model failures
  never produce model-authored fallback text.

The deterministic public trace contains only call index, tool name, immutable
release ID, and sorted returned evidence IDs. It contains no prompts, tool
arguments/results, provider payload, or model chain-of-thought.

The Bedrock middleware preserves existing provider options, places prompt cache
points on the first system and last non-system message, and reports cache
read/write tokens for generated and streamed calls. Agent telemetry contains
only invocation/release identifiers, counts, duration, and outcome—never prompt
text, raw evidence, credentials, or PII.

## Verification

Run with Node `22.18.0`:

```text
corepack pnpm --filter @oracle/model-gateway typecheck
corepack pnpm --filter @oracle/model-gateway lint
corepack pnpm --filter @oracle/model-gateway test
corepack pnpm --filter @oracle/model-gateway build
corepack pnpm --filter @oracle/agent typecheck
corepack pnpm --filter @oracle/agent lint
corepack pnpm --filter @oracle/agent test
corepack pnpm --filter @oracle/agent build
```

Tests use deterministic scripted language models and mocked serving executors.
They cover all translations, release drift, prompt injection, restricted-output
redaction, unknown tools/fields, timeouts, limits, citations, traces, and
model/policy composition failure without network access or paid Bedrock calls.
Only the parent performs the single bounded hosted Bedrock qualification after
local review passes.
