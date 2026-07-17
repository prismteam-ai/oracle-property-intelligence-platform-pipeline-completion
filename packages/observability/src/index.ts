import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

export type Observability = Readonly<{
  logger: Logger;
  metrics: Metrics;
  tracer: Tracer;
}>;

export function createObservability(serviceName: string): Observability {
  return Object.freeze({
    logger: new Logger({ serviceName }),
    metrics: new Metrics({ namespace: 'OracleFoundation', serviceName }),
    tracer: new Tracer({ serviceName }),
  });
}
