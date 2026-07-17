import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
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

/** Creates exactly one Amazon Bedrock model. There is no registry or fallback route. */
export function createOracleModelGateway(
  input: BedrockGatewayConfig,
  telemetry?: PromptCacheTelemetrySink,
): OracleModelGateway {
  const config = bedrockGatewayConfigSchema.parse(input);
  const provider = createAmazonBedrock({ region: config.region });
  const model = wrapLanguageModel({
    model: provider(config.modelId),
    middleware: createBedrockPromptCacheMiddleware(telemetry),
  });
  return Object.freeze({ ...config, model });
}
