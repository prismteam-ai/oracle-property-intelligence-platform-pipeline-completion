import { FOUNDATION_STATUS } from '@oracle/contracts';

export const statusCards = [
  {
    eyebrow: 'Data plane',
    title: 'Property pipeline',
    state: FOUNDATION_STATUS.capabilities.propertyPipeline,
    detail:
      'County ingestion, reconciliation, DuckDB artifacts, and publication are not implemented yet.',
  },
  {
    eyebrow: 'Evaluator',
    title: 'Query experience',
    state: FOUNDATION_STATUS.capabilities.queryExperience,
    detail:
      'Property search, evidence-backed inquiries, and agent answers are not implemented yet.',
  },
  {
    eyebrow: 'Agent interface',
    title: 'Full MCP work',
    state: FOUNDATION_STATUS.capabilities.mcpProtocol,
    detail: 'MCP tools and protocol handling are not implemented yet; non-health calls return 501.',
  },
] as const;
