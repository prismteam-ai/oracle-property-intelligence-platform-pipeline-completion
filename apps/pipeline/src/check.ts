export type PipelineCheck = Readonly<{
  command: 'pipeline.check';
  networkAccess: false;
  status: 'ok';
  pipelineState: 'production_composition_available';
  publicationEffects: false;
}>;

export function runCheck(): PipelineCheck {
  return Object.freeze({
    command: 'pipeline.check',
    networkAccess: false,
    status: 'ok',
    pipelineState: 'production_composition_available',
    publicationEffects: false,
  });
}
