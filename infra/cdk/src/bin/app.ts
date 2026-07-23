import * as cdk from 'aws-cdk-lib';

import { bedrockPromotionFromContext, optionalStringContext } from '../lib/bedrock-promotion.js';
import { OracleFoundationStack } from '../lib/oracle-foundation-stack.js';

const app = new cdk.App();

function optionalContext(name: string): string | undefined {
  return optionalStringContext((contextName) => app.node.tryGetContext(contextName), name);
}

new OracleFoundationStack(app, 'OracleFoundationStack', {
  bedrockPromotion: bedrockPromotionFromContext((name) => app.node.tryGetContext(name)),
  env: {
    account: '417242953053',
    region: 'us-east-2',
  },
  publicReleaseDirectory: optionalContext('oraclePublicReleaseDirectory'),
  servingConfigRelativePath: optionalContext('oracleServingConfigRelativePath'),
});
