# Oracle evaluator closeout walkthrough

Use the parent-supplied `WebUrl`, `ApiUrl`, `McpUrl`, and
`PublicArtifactUrl` from the same deployment. Do not copy an older URL from a
document or infer one from a stack name. Confirm the hosted release suite is
green before recording.

No demo video is claimed by this repository. This is the recording script for
the parent to use after deployment and the single bounded Bedrock proof.

## Preflight

1. Open `WebUrl` in a clean browser profile.
2. Confirm the global immutable release label is visible and matches
   `POST ApiUrl/dataset.getInfo`.
3. Confirm `GET ApiUrl/health` and `GET ApiUrl/mcp/health` are ready,
   non-fixture, and query-free.
4. Keep the hosted Playwright report available as supporting evidence.

## Recording sequence

1. **Overview and release.** Show the immutable release ID, county counts,
   source coverage, and limitations. State that capability labels are release
   facts, not model judgments.
2. **Pipeline and coverage.** Open `/pipeline` and `/coverage`. Show source
   counts, as-of timestamps, provenance, constrained sources, and truthful
   blocked/partial states.
3. **Property evidence.** Search for a real hosted property, open its detail,
   and show public evidence identifiers and source references without exposing
   restricted owner identity.
4. **Six fixed inquiries.** Execute roof age, water candidate, ownership age,
   regional owner, transit walkability, and Starbucks walkability. For empty or
   blocked results, show the returned capability and limitation instead of
   claiming a positive match.
5. **Transparent ranking.** Open `/rankings`; show deterministic component
   weights, support classes, contributions, evidence coverage, and stable
   ordering. State that the model does not calculate the score.
6. **SQL-free DuckDB console.** Open `/query-console`; choose one fixed named
   operation and run it. Show release ID, operation, DuckDB version, elapsed
   time, bytes scanned, row count, evidence, and limitations. Point out that no
   SQL, relation, file, URL, or object-path input exists.
7. **Agent proof.** Open `/agent`; show available status and the actual selected
   Bedrock model/profile. Ask one bounded evidence question. Wait for the
   terminal answer, then show exact citations and the named-tool trace. Do not
   expose chain-of-thought, prompts, tool arguments, or raw tool payloads.
8. **MCP proof.** Open `/mcp`; show the exact 16 SQL-free tools. Use the hosted
   test evidence for `initialize -> tools/list -> tools/call`, strict schema
   rejection, and API/MCP release parity.
9. **Portable artifacts.** Open `/artifacts`; show public hashes and sizes.
   Reference the hosted `HEAD`, range, and SHA-256 checks against
   `PublicArtifactUrl`. Explain that restricted artifacts have no public route.
10. **Scale-to-zero close.** Open `/about/architecture`; explain immutable
    public artifacts, packaged DuckDB, Lambda/API/MCP scale-to-zero compute,
    Bedrock per-request inference, and the absence of an always-on database.

## Failure handling during recording

- Stop if any surface shows `TEST_ONLY_DETERMINISTIC_FIXTURE`.
- Stop if API, MCP, UI, manifest, or agent responses show different release
  IDs.
- Stop if agent status is degraded, policy-drifted, or omits the selected
  model/profile.
- Do not replace an unavailable agent with a canned answer or record a second
  provider/model as a workaround.
- Do not publish IPFS, deploy, or change cloud configuration while recording.
