export const BEDROCK_PROMOTION_CONTEXT_KEYS = Object.freeze([
  'oracleBedrockInferenceProfileArn',
  'oracleBedrockInvocationResourceArns',
  'oracleBedrockModelId',
  'oracleBedrockRegion',
  'oracleAgentPolicyHash',
] as const);

export type BedrockPromotion = Readonly<{
  inferenceProfileArn: string;
  invocationResourceArns: readonly string[];
  modelId: string;
  region: 'us-east-1' | 'us-east-2';
  semanticPolicyHash: string;
}>;

type ContextReader = (name: string) => unknown;

export function optionalStringContext(read: ContextReader, name: string): string | undefined {
  const value = read(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`CDK context ${name} must be a non-empty string.`);
  }
  return value.trim();
}

export function bedrockPromotionFromContext(read: ContextReader): BedrockPromotion | undefined {
  const values = Object.fromEntries(
    BEDROCK_PROMOTION_CONTEXT_KEYS.map((name) => [name, optionalStringContext(read, name)]),
  ) as Record<(typeof BEDROCK_PROMOTION_CONTEXT_KEYS)[number], string | undefined>;
  const present = BEDROCK_PROMOTION_CONTEXT_KEYS.filter((name) => values[name] !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== BEDROCK_PROMOTION_CONTEXT_KEYS.length) {
    const missing = BEDROCK_PROMOTION_CONTEXT_KEYS.filter((name) => values[name] === undefined);
    throw new Error(`Bedrock promotion context is all-or-none; missing: ${missing.join(', ')}.`);
  }

  const required = (name: (typeof BEDROCK_PROMOTION_CONTEXT_KEYS)[number]): string => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`Bedrock promotion context unexpectedly omitted ${name}.`);
    }
    return value;
  };

  const region = required('oracleBedrockRegion');
  if (region !== 'us-east-1' && region !== 'us-east-2') {
    throw new Error('oracleBedrockRegion must be us-east-1 or us-east-2.');
  }

  return Object.freeze({
    inferenceProfileArn: required('oracleBedrockInferenceProfileArn'),
    invocationResourceArns: Object.freeze(
      required('oracleBedrockInvocationResourceArns')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
    modelId: required('oracleBedrockModelId'),
    region,
    semanticPolicyHash: required('oracleAgentPolicyHash'),
  });
}
