import { z } from 'zod';

export const semanticPolicyHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, 'Expected a sha256 semantic policy hash');

export const bedrockGatewayConfigSchema = z.strictObject({
  provider: z.literal('amazon-bedrock'),
  modelId: z.string().trim().min(1).max(512),
  region: z.enum(['us-east-1', 'us-east-2']),
  semanticPolicyHash: semanticPolicyHashSchema,
});

export type BedrockGatewayConfig = z.infer<typeof bedrockGatewayConfigSchema>;

export class GatewayConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigurationError';
  }
}

export function loadBedrockGatewayConfig(
  environment: Readonly<Record<string, string | undefined>>,
): BedrockGatewayConfig {
  const candidate = {
    provider: environment.ORACLE_MODEL_PROVIDER,
    modelId: environment.ORACLE_BEDROCK_MODEL_ID,
    region: environment.ORACLE_BEDROCK_REGION,
    semanticPolicyHash: environment.ORACLE_AGENT_POLICY_HASH,
  };
  const parsed = bedrockGatewayConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new GatewayConfigurationError(
      `Oracle agent model configuration is incomplete or invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return Object.freeze(parsed.data);
}
