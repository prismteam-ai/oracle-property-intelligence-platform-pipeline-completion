import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { wrapLanguageModel, type LanguageModel } from 'ai';

import { bedrockGatewayConfigSchema, type BedrockGatewayConfig } from './config.js';
import {
  createBedrockPromptCacheMiddleware,
  type PromptCacheTelemetrySink,
} from './prompt-cache.js';

export type OracleModelGateway = Readonly<{
  provider: 'amazon-bedrock';
  modelId: string;
  region: 'us-east-1' | 'us-east-2';
  semanticPolicyHash: string;
  model: LanguageModel;
}>;

export class GatewayProbeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GatewayProbeError';
  }
}

function runtimeRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.freeze(Object.fromEntries(Object.entries(value)));
}

/** Creates exactly one Amazon Bedrock model. There is no registry or fallback route. */
export function createOracleModelGateway(
  input: BedrockGatewayConfig,
  telemetry?: PromptCacheTelemetrySink,
): OracleModelGateway {
  const config = bedrockGatewayConfigSchema.parse(input);
  const provider = createAmazonBedrock({
    region: config.region,
    credentialProvider: fromNodeProviderChain(),
  });
  const model = wrapLanguageModel({
    model: provider(config.modelId),
    middleware: createBedrockPromptCacheMiddleware(telemetry),
  });
  return Object.freeze({ ...config, model });
}

/** Query-free construction probe. Live invocation qualification is a separate release gate. */
export function probeOracleModelGateway(gateway: OracleModelGateway): void {
  const candidate = runtimeRecord(gateway);
  const model = runtimeRecord(candidate?.model);
  if (
    candidate?.provider !== 'amazon-bedrock' ||
    typeof candidate.modelId !== 'string' ||
    candidate.modelId.trim().length === 0 ||
    model?.provider !== 'amazon-bedrock' ||
    model.modelId !== candidate.modelId
  ) {
    throw new GatewayProbeError('Oracle Bedrock gateway construction probe failed');
  }
}
