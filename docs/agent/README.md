# Oracle Bedrock named-tool agent

This package implements the Wave 3A Oracle agent as a Vercel AI SDK
`ToolLoopAgent` over exactly one Amazon Bedrock model. It has no provider
registry, default model, rules-engine answer path, canned success response, or
silent fallback.

## Runtime boundary

The agent receives only the sixteen frozen, SQL-free named evidence functions.
The host must inject a release-bound `NamedEvidenceExecutor`; startup fails when
the executor is absent. Every tool input is a strict Zod object, every result is
validated against the common evidence envelope, and release mismatch fails
closed. The payload guard rejects raw fields, restricted owner fields, query
authority, physical locations, and network/object locators before a result is
shown to the model.

The inherited Wave 3A baseline does not contain executable six-inquiry query
implementations in `query-core`. Consequently this package does not fabricate a
production executor. The API/MCP integration owner must inject the frozen
release adapter after that dependency exists; until then, live agent
qualification and direct-query parity remain blocked.

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
- 30-second total and 10-second step timeouts;
- prompts at most 8,000 characters;
- exact immutable release binding;
- returned property facts require `[evidence:<returned ID>]` citations;
- fabricated IDs, omitted citations, and erased unknown/unsupported states fail
  the request;
- dependency/model failures return errors and never model-authored fallback text.

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

Tests use deterministic scripted language models and mocked evidence executors.
They make no paid Bedrock calls. A paid live qualification is intentionally out
of scope for Wave 3A.
