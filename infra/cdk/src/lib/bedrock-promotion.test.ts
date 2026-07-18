import { describe, expect, it } from 'vitest';

import {
  BEDROCK_PROMOTION_CONTEXT_KEYS,
  bedrockPromotionFromContext,
} from './bedrock-promotion.js';

const completeContext = Object.freeze({
  oracleBedrockInferenceProfileArn:
    'arn:aws:bedrock:us-east-2:417242953053:inference-profile/us.oracle-profile-v1',
  oracleBedrockInvocationResourceArns:
    'arn:aws:bedrock:us-east-2:417242953053:inference-profile/us.oracle-profile-v1,arn:aws:bedrock:us-east-2::foundation-model/example.model-v1:0',
  oracleBedrockModelId: 'us.oracle-profile-v1',
  oracleBedrockRegion: 'us-east-2',
  oracleAgentPolicyHash: `sha256:${'a'.repeat(64)}`,
} as const);

function readContext(values: Readonly<Record<string, unknown>>) {
  return (name: string): unknown => values[name];
}

describe('Bedrock promotion context', () => {
  it('returns absent only when every promotion context is absent', () => {
    expect(bedrockPromotionFromContext(readContext({}))).toBeUndefined();
  });

  it('loads the exact five-context promotion without defaults', () => {
    expect(bedrockPromotionFromContext(readContext(completeContext))).toEqual({
      inferenceProfileArn: completeContext.oracleBedrockInferenceProfileArn,
      invocationResourceArns: completeContext.oracleBedrockInvocationResourceArns.split(','),
      modelId: completeContext.oracleBedrockModelId,
      region: completeContext.oracleBedrockRegion,
      semanticPolicyHash: completeContext.oracleAgentPolicyHash,
    });
  });

  it.each(BEDROCK_PROMOTION_CONTEXT_KEYS)(
    'rejects an otherwise complete promotion missing %s',
    (missing) => {
      const partial = Object.fromEntries(
        Object.entries(completeContext).filter(([name]) => name !== missing),
      );
      expect(() => bedrockPromotionFromContext(readContext(partial))).toThrow(
        `missing: ${missing}`,
      );
    },
  );

  it('rejects empty resources and unapproved regions before stack synthesis', () => {
    expect(() =>
      bedrockPromotionFromContext(
        readContext({ ...completeContext, oracleBedrockInvocationResourceArns: '  ' }),
      ),
    ).toThrow('must be a non-empty string');
    expect(() =>
      bedrockPromotionFromContext(
        readContext({ ...completeContext, oracleBedrockRegion: 'eu-west-1' }),
      ),
    ).toThrow('must be us-east-1 or us-east-2');
  });
});
