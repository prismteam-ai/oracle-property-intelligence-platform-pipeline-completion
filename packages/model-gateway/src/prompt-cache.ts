import type { LanguageModelMiddleware } from 'ai';

export type PromptCacheOperation = 'generated' | 'streamed';

export type PromptCacheTelemetry = Readonly<{
  operation: PromptCacheOperation;
  strategy: 'first-system-last-non-system';
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}>;

export type PromptCacheTelemetrySink = (event: PromptCacheTelemetry) => void;
type MiddlewareCallOptions = Parameters<
  NonNullable<LanguageModelMiddleware['transformParams']>
>[0]['params'];
type ProviderOptions = NonNullable<MiddlewareCallOptions['prompt'][number]['providerOptions']>;

const CACHE_POINT = Object.freeze({ cachePoint: { type: 'default' as const } });

function withCachePoint(providerOptions: ProviderOptions | undefined): ProviderOptions {
  const bedrock = providerOptions?.bedrock ?? {};
  return {
    ...providerOptions,
    bedrock: { ...bedrock, ...CACHE_POINT },
  };
}

function cacheUsage(usage: {
  inputTokens: { cacheRead: number | undefined; cacheWrite: number | undefined };
}): Pick<PromptCacheTelemetry, 'cacheReadInputTokens' | 'cacheWriteInputTokens'> {
  return {
    cacheReadInputTokens: usage.inputTokens.cacheRead ?? 0,
    cacheWriteInputTokens: usage.inputTokens.cacheWrite ?? 0,
  };
}

/** Adds Bedrock cache points without replacing any existing provider options. */
export function createBedrockPromptCacheMiddleware(
  telemetry: PromptCacheTelemetrySink = () => undefined,
): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: ({ params }) => {
      const firstSystem = params.prompt.findIndex((message) => message.role === 'system');
      let lastNonSystem = -1;
      for (let index = params.prompt.length - 1; index >= 0; index -= 1) {
        if (params.prompt[index]?.role !== 'system') {
          lastNonSystem = index;
          break;
        }
      }
      return Promise.resolve({
        ...params,
        prompt: params.prompt.map((message, index) =>
          index === firstSystem || index === lastNonSystem
            ? { ...message, providerOptions: withCachePoint(message.providerOptions) }
            : message,
        ),
      });
    },
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      telemetry({
        operation: 'generated',
        strategy: 'first-system-last-non-system',
        ...cacheUsage(result.usage),
      });
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'finish') {
              telemetry({
                operation: 'streamed',
                strategy: 'first-system-last-non-system',
                ...cacheUsage(part.usage),
              });
            }
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream };
    },
  };
}
