#!/usr/bin/env node
/**
 * Oracle pipeline status publisher (read-only sidecar).
 *
 * Derives run progress from checkpoint files on disk and publishes a single
 * status document. It runs BESIDE the pipeline and must never perturb it.
 *
 * ── Hard safety rules (violating any of these can destroy a live run) ────────
 *  1. Reads with plain readFile + JSON.parse. Never instantiates a
 *     CheckpointStore. RetryableAcquisitionCheckpointStore.load() can commit a
 *     new revision as a side effect and would race the live writer into a
 *     checkpoint conflict — the single most dangerous mistake available here.
 *  2. Never opens a .duckdb file. DuckDB is single-writer; the pipeline holds it.
 *  3. Never writes, renames, or deletes anything inside the run directory.
 *  4. Skips any entry that is not a plain *.json file. During a commit a
 *     "<sha256>.json.lock" DIRECTORY and a "<sha256>.json.<rev>.tmp" file exist
 *     transiently. Never create or remove the lock.
 *  5. Tolerates ENOENT / partial reads / parse failure by skipping that tick.
 *     Checkpoints are promoted by atomic rename, so a successful parse is a
 *     consistent snapshot, but a read may still land mid-rename.
 *
 * Progress honesty: a real fraction is emitted only where a real denominator
 * exists (completed partitions / partition count). Anything without a genuine
 * denominator is reported as null and MUST render as "Not available" — never 0,
 * never a synthesized percentage.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const STATUS_SCHEMA_VERSION = 'oracle-pipeline-status-v1';
const BOUNDED_CHECKPOINT_SCHEMA = 'oracle-bounded-processing-checkpoint-v1';

/** Mirrors BOUNDED_PROCESSING_STAGES (packages/contracts/src/bounded-processing.ts:151). */
const COMPUTE_STAGES = Object.freeze([
  'partition_mutations',
  'reduce_canonical',
  'build_link_index',
  'reconcile_links',
  'derive_features',
  'build_marts',
  'finalize_release',
]);

/** Mirrors ORCHESTRATION_PHASES (apps/pipeline/src/orchestration/types.ts:17). */
const ORCHESTRATION_PHASES = Object.freeze([
  'discover',
  'plan',
  'acquire',
  'decode',
  'validate',
  'normalize',
  'summarize',
  'reconcile',
  'derive_features',
  'build_marts',
  'finalize',
]);

function parseArgs(argv) {
  const args = { interval: 15, inspect: false, once: false, pid: null, checkpoints: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--inspect') args.inspect = true;
    else if (arg === '--once') args.once = true;
    else if (arg === '--checkpoints') args.checkpoints = argv[++i];
    else if (arg === '--pid') args.pid = Number(argv[++i]);
    else if (arg === '--interval') args.interval = Number(argv[++i]);
    else if (arg === '--s3-bucket') args.bucket = argv[++i];
    else if (arg === '--s3-key') args.key = argv[++i];
  }
  if (!args.checkpoints) {
    throw new Error('Usage: publisher.mjs --checkpoints <dir> [--pid N] [--inspect] [--once]');
  }
  return args;
}

/** Read every committed checkpoint envelope. Read-only; skips anything unreadable. */
async function readCheckpoints(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const envelopes = [];
  for (const entry of entries) {
    // Rule 4: only plain *.json files. Excludes the .lock DIRECTORY and .tmp files.
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(directory, entry.name), 'utf8');
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && 'payload' in value) {
        envelopes.push({ file: entry.name, envelope: value });
      }
    } catch {
      // Mid-rename read, partial write, or non-checkpoint JSON. Skip this tick.
    }
  }
  return envelopes;
}

function isBoundedProcessing(payload) {
  return payload?.schemaVersion === BOUNDED_CHECKPOINT_SCHEMA;
}

function isRunState(payload) {
  return Array.isArray(payload?.sources) && !isBoundedProcessing(payload);
}

/**
 * Per-source acquisition cursors (scope "sc:source:…/sc:snapshot:…"). Observed
 * live: they carry acquiredArtifactIds / complete / cursor / nextSequence.
 * Not used for progress — the run-state checkpoint is the authoritative
 * per-source view — but classified so they are not reported as unknown.
 */
function isAcquisitionCursor(payload) {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'acquiredArtifactIds' in payload &&
    'snapshotId' in payload
  );
}

/** Latest by writtenAt; checkpoints are revisioned, and we want the newest snapshot. */
function newest(records) {
  return records
    .slice()
    .sort((a, b) => String(a.envelope.writtenAt).localeCompare(String(b.envelope.writtenAt)))
    .pop();
}

function deriveSources(runPayload) {
  return (runPayload.sources ?? []).map((source) => {
    const completed = source.completedPhase ?? null;
    const index = completed === null ? -1 : ORCHESTRATION_PHASES.indexOf(completed);
    // completedPhase marks a FINISHED phase (runner.ts:755). The in-flight phase
    // is the next one; rendering completedPhase as current would be off by one.
    const current =
      source.terminalState !== null ? null : (ORCHESTRATION_PHASES[index + 1] ?? null);
    return {
      sourceId: source.sourceId ?? null,
      completedPhase: completed,
      currentPhase: current,
      terminalState: source.terminalState ?? 'in_progress',
      decodedRecords: source.decodedRecords ?? null,
      acceptedRecords: source.acceptedRecords ?? null,
      rejectedRecords: source.rejectedRecords ?? null,
      // No record denominator is persisted anywhere, so a ratio would be invented.
      expectedRecords: null,
      recordRatio: null,
    };
  });
}

function deriveCompute(payload) {
  const completedStages = (payload.completedStages ?? []).map((entry) => entry.stage);
  const currentStage = COMPUTE_STAGES.find((stage) => !completedStages.includes(stage)) ?? null;
  const partitionCount = payload.partitionPlan?.partitionCount ?? null;
  const durable = Array.isArray(payload.durablePartitions) ? payload.durablePartitions.length : 0;
  return {
    stages: COMPUTE_STAGES,
    completedStages,
    currentStage,
    currentStageIndex: currentStage === null ? null : COMPUTE_STAGES.indexOf(currentStage) + 1,
    stageCount: COMPUTE_STAGES.length,
    partitionCount,
    durablePartitionsInCurrentStage: durable,
    // The ONLY genuine fraction available. Null when the denominator is unknown.
    partitionFraction:
      partitionCount && partitionCount > 0 ? Number((durable / partitionCount).toFixed(4)) : null,
    activeCursor: payload.activeCursor ?? null,
  };
}

function processAlive(pid) {
  if (pid === null || Number.isNaN(pid)) return null;
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function buildStatus(args) {
  const records = await readCheckpoints(args.checkpoints);
  const runRecord = newest(records.filter((r) => isRunState(r.envelope.payload)));
  const computeRecord = newest(records.filter((r) => isBoundedProcessing(r.envelope.payload)));

  const alive = processAlive(args.pid);
  const writtenAt =
    computeRecord?.envelope.writtenAt ?? runRecord?.envelope.writtenAt ?? null;
  const observedAt = new Date().toISOString();
  const staleSeconds =
    writtenAt === null
      ? null
      : Math.max(0, Math.round((Date.parse(observedAt) - Date.parse(writtenAt)) / 1000));

  const compute = computeRecord ? deriveCompute(computeRecord.envelope.payload) : null;
  const sources = runRecord ? deriveSources(runRecord.envelope.payload) : [];

  // 'stalled' is claimed ONLY on observed process death.
  //
  // An earlier draft also declared 'stalled' when staleSeconds > 900. Validated
  // against a live run (Stage 0) that rule was plainly wrong: a healthy run at
  // ~1.0 core had a run-state checkpoint 934s old, because the pipeline does not
  // checkpoint during long single-phase work. Treating checkpoint quiet as death
  // would raise constant false alarms and teach the reader to ignore the badge.
  //
  // Checkpoint quiet is therefore reported as neutral information
  // (checkpointQuietSeconds) and never as a failure claim. Note we cannot detect
  // a HUNG process from checkpoints alone — the reliable signal is CPU rate over
  // a window, not cumulative CPU, and not checkpoint age.
  let phase;
  if (alive === false) phase = 'stalled';
  else if (compute && compute.currentStage === null) phase = 'verifying';
  else if (compute) phase = 'computing';
  else if (sources.length > 0) phase = 'acquiring';
  else phase = 'queued';

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    runId: runRecord?.envelope.payload?.runId ?? computeRecord?.envelope.payload?.runId ?? null,
    profile: runRecord?.envelope.payload?.profile?.name ?? null,
    requestedAt: runRecord?.envelope.payload?.requestedAt ?? null,
    phase,
    observedAt,
    processAlive: alive,
    checkpointWrittenAt: writtenAt,
    // Neutral observation, NOT a health verdict. See the phase comment above:
    // a healthy run was measured quiet for 934s.
    checkpointQuietSeconds: staleSeconds,
    checkpointCount: records.length,
    sources,
    compute,
    publish: { manifestCid: null, releaseId: null, publishedAt: null },
  };
}

/**
 * Stage-0 validation aid: report what is actually on disk and the shape of each
 * payload, so the derivation is checked against reality instead of assumptions.
 */
async function inspect(args) {
  const records = await readCheckpoints(args.checkpoints);
  console.log(`checkpoint files parsed: ${records.length}`);
  for (const { file, envelope } of records) {
    const payload = envelope.payload ?? {};
    const kind = isBoundedProcessing(payload)
      ? 'BOUNDED_PROCESSING'
      : isRunState(payload)
        ? 'RUN_STATE'
        : isAcquisitionCursor(payload)
          ? 'ACQUISITION_CURSOR'
          : 'UNCLASSIFIED';
    console.log(
      [
        `\n[${kind}] ${file}`,
        `  scope:     ${envelope.scope}`,
        `  writtenAt: ${envelope.writtenAt}`,
        `  revision:  ${String(envelope.revision).slice(0, 16)}…`,
        `  payload keys: ${Object.keys(payload).join(', ')}`,
      ].join('\n'),
    );
    if (isRunState(payload)) {
      console.log(`  sources: ${payload.sources.length}`);
      for (const s of payload.sources.slice(0, 20)) {
        console.log(
          `    - ${s.sourceId} completed=${s.completedPhase} terminal=${s.terminalState} decoded=${s.decodedRecords} accepted=${s.acceptedRecords}`,
        );
      }
    }
    if (isBoundedProcessing(payload)) {
      console.log(`  completedStages: ${(payload.completedStages ?? []).map((s) => s.stage).join(', ') || '(none)'}`);
      console.log(`  durablePartitions: ${(payload.durablePartitions ?? []).length}`);
      console.log(`  partitionCount: ${payload.partitionPlan?.partitionCount ?? '(unknown)'}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Fail loudly rather than silently reporting an empty run.
  await stat(args.checkpoints);

  if (args.inspect) {
    await inspect(args);
    return;
  }
  if (args.once) {
    console.log(JSON.stringify(await buildStatus(args), null, 2));
    return;
  }

  let lastSerialized = null;
  for (;;) {
    try {
      const status = await buildStatus(args);
      const serialized = JSON.stringify(status);
      // Only emit on change; during a long single partition nothing moves.
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        console.log(serialized);
      }
    } catch (error) {
      console.error(`status tick failed (continuing): ${error?.message ?? error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, args.interval * 1000));
  }
}

await main();
