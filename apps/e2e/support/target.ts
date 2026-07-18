export const LOCAL_BASE_URL = 'http://127.0.0.1:4173';

export type EvaluatorTarget = 'local' | 'hosted';

export type EvaluatorTargetConfiguration = Readonly<{
  target: EvaluatorTarget;
  baseURL: string;
  apiBaseURL: string;
  mcpURL: string;
  publicArtifactBaseURL: string;
  startLocalServer: boolean;
}>;

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

function cleanBaseUrl(value: string, target: EvaluatorTarget, variable: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be an absolute URL for the ${target} lane.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${variable} must use HTTP or HTTPS.`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`${variable} cannot contain credentials, a query, or a fragment.`);
  }
  if (target === 'hosted') {
    if (url.protocol !== 'https:') {
      throw new Error(`${variable} must use HTTPS in the hosted lane.`);
    }
    if (localHosts.has(url.hostname)) {
      throw new Error(`${variable} cannot use a loopback host in the hosted lane.`);
    }
  } else if (!localHosts.has(url.hostname)) {
    throw new Error(`${variable} must use a loopback host in the local lane.`);
  }

  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString().replace(/\/$/u, '');
}

export function evaluatorTargetConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): EvaluatorTargetConfiguration {
  const rawTarget = environment.ORACLE_E2E_TARGET ?? 'local';
  if (rawTarget !== 'local' && rawTarget !== 'hosted') {
    throw new Error('ORACLE_E2E_TARGET must be either local or hosted.');
  }
  const hostedVariables = [
    'ORACLE_E2E_BASE_URL',
    'ORACLE_E2E_API_BASE_URL',
    'ORACLE_E2E_MCP_URL',
    'ORACLE_E2E_PUBLIC_ARTIFACT_BASE_URL',
  ] as const;
  if (rawTarget === 'hosted') {
    const missing = hostedVariables.filter((name) => environment[name] === undefined);
    if (missing.length > 0) {
      throw new Error(`Hosted evaluator tests require explicit ${missing.join(', ')} values.`);
    }
  }

  const baseURL = cleanBaseUrl(
    environment.ORACLE_E2E_BASE_URL ?? LOCAL_BASE_URL,
    rawTarget,
    'ORACLE_E2E_BASE_URL',
  );
  const apiBaseURL = cleanBaseUrl(
    environment.ORACLE_E2E_API_BASE_URL ?? 'http://127.0.0.1:4174',
    rawTarget,
    'ORACLE_E2E_API_BASE_URL',
  );
  const mcpURL = cleanBaseUrl(
    environment.ORACLE_E2E_MCP_URL ?? 'http://127.0.0.1:4174/mcp',
    rawTarget,
    'ORACLE_E2E_MCP_URL',
  );
  const publicArtifactBaseURL = cleanBaseUrl(
    environment.ORACLE_E2E_PUBLIC_ARTIFACT_BASE_URL ?? 'http://127.0.0.1:4174/public-artifacts',
    rawTarget,
    'ORACLE_E2E_PUBLIC_ARTIFACT_BASE_URL',
  );
  if (!new URL(mcpURL).pathname.endsWith('/mcp')) {
    throw new Error('ORACLE_E2E_MCP_URL must identify the exact /mcp endpoint.');
  }
  return Object.freeze({
    target: rawTarget,
    baseURL,
    apiBaseURL,
    mcpURL,
    publicArtifactBaseURL,
    startLocalServer: rawTarget === 'local' && environment.ORACLE_E2E_SKIP_WEB_SERVER !== '1',
  });
}

export function isHostedTarget(environment: NodeJS.ProcessEnv = process.env): boolean {
  return evaluatorTargetConfiguration(environment).target === 'hosted';
}
