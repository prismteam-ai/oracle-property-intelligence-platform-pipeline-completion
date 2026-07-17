import * as cdk from 'aws-cdk-lib';

import { OracleFoundationStack, type BedrockPromotion } from '../lib/oracle-foundation-stack.js';

const app = new cdk.App();

function optionalContext(name: string): string | undefined {
  const value: unknown = app.node.tryGetContext(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`CDK context ${name} must be a non-empty string.`);
  }
  return value.trim();
}

function bedrockPromotion(): BedrockPromotion | undefined {
  const inferenceProfileArn = optionalContext('oracleBedrockInferenceProfileArn');
  const invocationResources = optionalContext('oracleBedrockInvocationResourceArns');
  const modelId = optionalContext('oracleBedrockModelId');
  const region = optionalContext('oracleBedrockRegion');
  const semanticPolicyHash = optionalContext('oracleAgentPolicyHash');
  if (
    inferenceProfileArn === undefined &&
    invocationResources === undefined &&
    modelId === undefined &&
    region === undefined &&
    semanticPolicyHash === undefined
  ) {
    return undefined;
  }
  if (
    inferenceProfileArn === undefined ||
    invocationResources === undefined ||
    modelId === undefined ||
    region === undefined ||
    semanticPolicyHash === undefined
  ) {
    throw new Error(
      'Bedrock promotion context is all-or-none; partial model wiring is prohibited.',
    );
  }
  if (region !== 'us-east-1' && region !== 'us-east-2') {
    throw new Error('oracleBedrockRegion must be us-east-1 or us-east-2.');
  }

  return {
    inferenceProfileArn,
    invocationResourceArns: invocationResources
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    modelId,
    region,
    semanticPolicyHash,
  };
}

new OracleFoundationStack(app, 'OracleFoundationStack', {
  bedrockPromotion: bedrockPromotion(),
  env: {
    account: '417242953053',
    region: 'us-east-2',
  },
  publicReleaseDirectory: optionalContext('oraclePublicReleaseDirectory'),
  servingConfigRelativePath: optionalContext('oracleServingConfigRelativePath'),
});
