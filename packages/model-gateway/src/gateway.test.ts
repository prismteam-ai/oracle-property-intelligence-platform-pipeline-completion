import type { LanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { GatewayConfigurationError, loadBedrockGatewayConfig } from './config.js';
import { GatewayProbeError, probeOracleModelGateway } from './gateway.js';
import { createBedrockPromptCacheMiddleware } from './prompt-cache.js';

const usage = {
  inputTokens: { total: 9, noCache: 4, cacheRead: 3, cacheWrite: 2 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
type LanguageModelV3 = Extract<Exclude<LanguageModel, string>, { specificationVersion: 'v3' }>;
const mockModel = {} as LanguageModelV3;

describe('Bedrock gateway startup', () => {
  it('fails closed instead of selecting a provider or model default', () => {
    expect(() => loadBedrockGatewayConfig({})).toThrow(GatewayConfigurationError);
    expect(() =>
      loadBedrockGatewayConfig({
        ORACLE_MODEL_PROVIDER: 'openai',
        ORACLE_BEDROCK_MODEL_ID: 'some-model',
        ORACLE_BEDROCK_REGION: 'us-east-2',
        ORACLE_AGENT_POLICY_HASH: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow(GatewayConfigurationError);
  });

  it('uses a query-free construction probe and rejects model/profile drift', () => {
    const gateway = {
      provider: 'amazon-bedrock' as const,
      modelId: 'test-profile',
      region: 'us-east-2' as const,
      semanticPolicyHash: `sha256:${'a'.repeat(64)}`,
      model: {
        specificationVersion: 'v3' as const,
        provider: 'amazon-bedrock',
        modelId: 'test-profile',
        supportedUrls: {},
        doGenerate: () => Promise.reject(new Error('probe must not generate')),
        doStream: () => Promise.resolve({ stream: new ReadableStream() }),
      },
    };
    expect(() => probeOracleModelGateway(gateway)).not.toThrow();
    expect(() => probeOracleModelGateway({ ...gateway, modelId: 'different-profile' })).toThrow(
      GatewayProbeError,
    );
  });
});

describe('Bedrock prompt cache middleware', () => {
  it('places cache points on first system and last non-system messages and preserves options', async () => {
    const middleware = createBedrockPromptCacheMiddleware();
    const transformed = await middleware.transformParams?.({
      type: 'generate',
      model: mockModel,
      params: {
        prompt: [
          { role: 'system', content: 'policy', providerOptions: { bedrock: { trace: 'enabled' } } },
          { role: 'user', content: [{ type: 'text', text: 'first' }] },
          {
            role: 'user',
            content: [{ type: 'text', text: 'last' }],
            providerOptions: { x: { y: 1 } },
          },
        ],
      },
    });
    expect(transformed?.prompt[0]?.providerOptions).toMatchObject({
      bedrock: { trace: 'enabled', cachePoint: { type: 'default' } },
    });
    expect(transformed?.prompt[1]?.providerOptions).toBeUndefined();
    expect(transformed?.prompt[2]?.providerOptions).toMatchObject({
      x: { y: 1 },
      bedrock: { cachePoint: { type: 'default' } },
    });
  });

  it('records cache usage for generated and streamed responses', async () => {
    const sink = vi.fn();
    const middleware = createBedrockPromptCacheMiddleware(sink);
    await middleware.wrapGenerate?.({
      model: mockModel,
      params: { prompt: [] },
      doStream: vi.fn(),
      doGenerate: () =>
        Promise.resolve({
          content: [],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        }),
    });
    const streamed = await middleware.wrapStream?.({
      model: mockModel,
      params: { prompt: [] },
      doGenerate: vi.fn(),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'finish',
                usage,
                finishReason: { unified: 'stop', raw: 'stop' },
              });
              controller.close();
            },
          }),
        }),
    });
    if (streamed !== undefined) for await (const _part of streamed.stream) void _part;
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'generated', cacheReadInputTokens: 3 }),
    );
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'streamed', cacheWriteInputTokens: 2 }),
    );
  });
});
