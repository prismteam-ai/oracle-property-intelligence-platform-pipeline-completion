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

- at most 3 model steps and 6 tool calls;
- at most 2,048 output tokens;
- a 24-second total timeout and 20-second per-step timeout, nested inside the
  25-second API request budget, 29-second API Gateway integration, and 30-second
  Lambda boundary;
- zero provider retries: each model step issues exactly one request, with no
  model/profile fallback;
- prompts at most 8,000 characters;
- tool envelopes at most 900 KiB, 100 returned rows, and 1,000 evidence references;
- each analytical call at most 5 seconds and 512 MiB scanned;
- exact immutable release binding;
- returned property facts require `[evidence:<returned ID>]` citations;
- fabricated IDs, omitted citations, and erased unknown/unsupported states fail
  the request;
- dependency/model failures return errors and never model-authored fallback text.

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
