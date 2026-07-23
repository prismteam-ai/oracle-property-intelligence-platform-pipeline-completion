import {
  createOracleModelGateway,
  loadBedrockGatewayConfig,
  probeOracleModelGateway,
  type BedrockGatewayConfig,
  type OracleModelGateway,
} from '@oracle/model-gateway';
import type { RankingWeight } from '@oracle/query-core/inquiries/contracts';
import type {
  ProductionServingService,
  ServingCapabilities,
} from '@oracle/query-core/serving/contracts';

import { createOracleEvidenceAgent, type OracleEvidenceAgent } from './agent.js';
import { type NamedEvidenceToolName } from './contracts.js';
import { createSemanticPolicy, type EvidenceCapability, type SemanticPolicy } from './policy.js';
import { createProductionServingExecutor } from './serving-adapter.js';

const inquiryCapabilityByTool = Object.freeze({
  find_roof_age_candidates: 'roof_age',
  find_water_view_candidates: 'water_view_candidate',
  find_ownership_age_candidates: 'ownership_age',
  find_regional_owner_properties: 'regional_owner',
  find_transit_walkable_properties: 'transit_walkability',
  find_starbucks_walkable_properties: 'starbucks_walkability',
} as const);
const allSupportStates = Object.freeze(['supported', 'proxy', 'unknown', 'unsupported'] as const);

export type ProductionOracleAgentComposition = Readonly<{
  agent: OracleEvidenceAgent;
  policy: SemanticPolicy;
  limitations: readonly string[];
}>;

export type ProductionOracleAgentDependencies = Readonly<{
  createGateway?: (config: BedrockGatewayConfig) => OracleModelGateway;
  probeGateway?: (gateway: OracleModelGateway) => void | Promise<void>;
}>;

function capabilityFor(
  name: NamedEvidenceToolName,
  capabilities: ServingCapabilities,
): EvidenceCapability {
  if (name === 'rank_review_candidates') {
    const blocked = Object.values(capabilities).filter(({ state }) => state === 'blocked');
    return Object.freeze({
      enabled: blocked.length === 0,
      supportStates: allSupportStates,
      ...(blocked.length === 0
        ? {}
        : { limitation: 'One or more immutable ranking capabilities are blocked.' }),
    });
  }
  const criterion = criterionFor(name);
  if (criterion !== null) {
    const capability = capabilities[criterion];
    return Object.freeze({
      enabled: capability.state !== 'blocked',
      supportStates: Object.freeze([...capability.supportClasses]),
      ...(capability.limitations.length === 0
        ? {}
        : { limitation: capability.limitations.join(' ') }),
    });
  }
  return Object.freeze({
    enabled: true,
    supportStates: allSupportStates,
  });
}

function criterionFor(
  name: NamedEvidenceToolName,
): (typeof inquiryCapabilityByTool)[keyof typeof inquiryCapabilityByTool] | null {
  switch (name) {
    case 'find_roof_age_candidates':
      return inquiryCapabilityByTool.find_roof_age_candidates;
    case 'find_water_view_candidates':
      return inquiryCapabilityByTool.find_water_view_candidates;
    case 'find_ownership_age_candidates':
      return inquiryCapabilityByTool.find_ownership_age_candidates;
    case 'find_regional_owner_properties':
      return inquiryCapabilityByTool.find_regional_owner_properties;
    case 'find_transit_walkable_properties':
      return inquiryCapabilityByTool.find_transit_walkable_properties;
    case 'find_starbucks_walkable_properties':
      return inquiryCapabilityByTool.find_starbucks_walkable_properties;
    default:
      return null;
  }
}

export function createProductionAgentSemanticPolicy(
  capabilities: ServingCapabilities,
): SemanticPolicy {
  return createSemanticPolicy({
    capabilities: Object.freeze({
      get_dataset_info: capabilityFor('get_dataset_info', capabilities),
      get_dataset_coverage: capabilityFor('get_dataset_coverage', capabilities),
      list_pipeline_runs: capabilityFor('list_pipeline_runs', capabilities),
      get_pipeline_run: capabilityFor('get_pipeline_run', capabilities),
      search_properties: capabilityFor('search_properties', capabilities),
      get_property: capabilityFor('get_property', capabilities),
      get_property_evidence: capabilityFor('get_property_evidence', capabilities),
      find_roof_age_candidates: capabilityFor('find_roof_age_candidates', capabilities),
      find_water_view_candidates: capabilityFor('find_water_view_candidates', capabilities),
      find_ownership_age_candidates: capabilityFor('find_ownership_age_candidates', capabilities),
      find_regional_owner_properties: capabilityFor('find_regional_owner_properties', capabilities),
      find_transit_walkable_properties: capabilityFor(
        'find_transit_walkable_properties',
        capabilities,
      ),
      find_starbucks_walkable_properties: capabilityFor(
        'find_starbucks_walkable_properties',
        capabilities,
      ),
      rank_review_candidates: capabilityFor('rank_review_candidates', capabilities),
      list_artifacts: capabilityFor('list_artifacts', capabilities),
      get_data_dictionary: capabilityFor('get_data_dictionary', capabilities),
    }),
    dataDictionary: Object.freeze({
      propertyId: 'Stable public property identifier.',
      evidenceId: 'Deterministic public evidence citation identifier.',
      supportState: 'One of supported, proxy, unknown, or unsupported.',
      releaseId: 'Immutable server-selected production release identifier.',
    }),
  });
}

export async function createProductionOracleAgent(
  input: Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    serving: ProductionServingService;
    rankingWeights: readonly RankingWeight[];
    capabilities: ServingCapabilities;
    limitations?: readonly string[];
  }>,
  dependencies: ProductionOracleAgentDependencies = {},
): Promise<ProductionOracleAgentComposition> {
  const policy = createProductionAgentSemanticPolicy(input.capabilities);
  const config = loadBedrockGatewayConfig(input.environment);
  const createGateway = dependencies.createGateway ?? createOracleModelGateway;
  const gateway = createGateway(config);
  const probeGateway = dependencies.probeGateway ?? probeOracleModelGateway;
  await probeGateway(gateway);
  const agent = createOracleEvidenceAgent({
    gateway,
    semanticPolicy: policy,
    executor: createProductionServingExecutor(input.serving, input.rankingWeights),
  });
  const limitations = Object.freeze(
    [
      ...(input.limitations ?? []),
      ...Object.values(input.capabilities).flatMap((capability) => capability.limitations),
    ]
      .filter((limitation) => limitation.trim().length > 0)
      .filter((limitation, index, values) => values.indexOf(limitation) === index)
      .sort(),
  );
  return Object.freeze({ agent, policy, limitations });
}
