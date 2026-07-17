import { FOUNDATION_STATUS } from '@oracle/contracts';

export type PipelineCheck = Readonly<{
  command: 'pipeline.check';
  networkAccess: false;
  status: 'ok';
  pipelineState: 'not_implemented';
}>;

export function runCheck(): PipelineCheck {
  return Object.freeze({
    command: 'pipeline.check',
    networkAccess: false,
    status: 'ok',
    pipelineState: FOUNDATION_STATUS.capabilities.propertyPipeline,
  });
}
