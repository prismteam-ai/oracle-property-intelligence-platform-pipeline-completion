import { z } from 'zod';

import { isoDateTimeSchema, nonEmptyStringSchema, semverSchema } from './foundation.js';
import { artifactIdSchema, runIdSchema, snapshotIdSchema, sourceIdSchema } from './ids.js';

export const pipelineStageSchema = z.enum([
  'discover',
  'plan',
  'acquire',
  'decode',
  'validate',
  'normalize',
  'reconcile',
  'derive_features',
  'build_marts',
  'summarize',
  'stage_publication',
]);

export type PipelineStage = z.infer<typeof pipelineStageSchema>;

export const pipelineStageRunSchema = z.strictObject({
  stage: pipelineStageSchema,
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'aborted', 'skipped']),
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  inputArtifactIds: z.array(artifactIdSchema),
  outputArtifactIds: z.array(artifactIdSchema),
  processedRecords: z.number().int().nonnegative(),
  rejectedRecords: z.number().int().nonnegative(),
  errorCodes: z.array(nonEmptyStringSchema),
});

export type PipelineStageRun = z.infer<typeof pipelineStageRunSchema>;

export const pipelineRunSchema = z
  .strictObject({
    runId: runIdSchema,
    pipelineVersion: semverSchema,
    status: z.enum(['planned', 'running', 'succeeded', 'partial', 'failed', 'aborted']),
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
    sourceIds: z.array(sourceIdSchema).min(1),
    snapshotIds: z.array(snapshotIdSchema).min(1),
    stages: z.array(pipelineStageRunSchema).min(1),
    outputArtifactIds: z.array(artifactIdSchema),
  })
  .superRefine((run, context) => {
    if (run.status === 'running' && run.completedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Running pipeline cannot be completed',
        path: ['completedAt'],
      });
    }
    if (
      ['succeeded', 'partial', 'failed', 'aborted'].includes(run.status) &&
      run.completedAt === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal pipeline run requires completedAt',
        path: ['completedAt'],
      });
    }
  });

export type PipelineRun = z.infer<typeof pipelineRunSchema>;

export const supportStateSchema = z.enum(['supported', 'proxy', 'unknown', 'unsupported']);
export type SupportState = z.infer<typeof supportStateSchema>;

export const coverageMetricSchema = z
  .strictObject({
    scope: z.enum(['source', 'entity', 'field', 'relationship', 'jurisdiction', 'time_interval']),
    key: nonEmptyStringSchema,
    supportState: supportStateSchema,
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1),
    measuredAt: isoDateTimeSchema,
    asOf: isoDateTimeSchema.nullable(),
    limitations: z.array(nonEmptyStringSchema),
  })
  .superRefine((metric, context) => {
    if (metric.numerator > metric.denominator) {
      context.addIssue({
        code: 'custom',
        message: 'Coverage numerator exceeds denominator',
        path: ['numerator'],
      });
    }
    const expectedRatio = metric.denominator === 0 ? 0 : metric.numerator / metric.denominator;
    if (Math.abs(metric.ratio - expectedRatio) > 1e-12) {
      context.addIssue({
        code: 'custom',
        message: 'Coverage ratio does not match counts',
        path: ['ratio'],
      });
    }
  });

export type CoverageMetric = z.infer<typeof coverageMetricSchema>;

export const datasetCoverageSchema = z.strictObject({
  runId: runIdSchema,
  generatedAt: isoDateTimeSchema,
  county: z.literal('Santa Clara'),
  state: z.literal('CA'),
  metrics: z.array(coverageMetricSchema).min(1),
});

export type DatasetCoverage = z.infer<typeof datasetCoverageSchema>;
