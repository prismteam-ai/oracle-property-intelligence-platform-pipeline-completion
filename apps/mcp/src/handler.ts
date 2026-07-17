import { UnavailableNamedEvidenceService } from './service.js';
import { createLambdaMcpHandler } from './transport.js';

/**
 * Production intentionally fails tool execution closed until composition injects the
 * verified immutable-release query service. Protocol discovery remains available.
 */
export const handler = createLambdaMcpHandler(new UnavailableNamedEvidenceService());

export { createLambdaMcpHandler } from './transport.js';
export type { NamedEvidenceRequest, NamedEvidenceService } from './service.js';
