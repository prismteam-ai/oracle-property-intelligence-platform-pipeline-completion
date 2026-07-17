export const LOCAL_BASE_URL = 'http://127.0.0.1:4173';

export type EvaluatorTarget = 'local' | 'hosted';

export type EvaluatorTargetConfiguration = Readonly<{
  target: EvaluatorTarget;
  baseURL: string;
  apiBaseURL: string;
  startLocalServer: boolean;
}>;

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

function cleanBaseUrl(value: string, target: EvaluatorTarget): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`ORACLE_E2E_BASE_URL must be an absolute URL for the ${target} lane.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('ORACLE_E2E_BASE_URL must use HTTP or HTTPS.');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('ORACLE_E2E_BASE_URL cannot contain credentials, a query, or a fragment.');
  }
  if (target === 'hosted') {
    if (url.protocol !== 'https:') {
      throw new Error('Hosted evaluator tests require an explicit HTTPS base URL.');
    }
    if (localHosts.has(url.hostname)) {
      throw new Error('Hosted evaluator tests refuse loopback base URLs.');
    }
  } else if (!localHosts.has(url.hostname)) {
    throw new Error('Local evaluator tests accept only loopback base URLs.');
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
  if (rawTarget === 'hosted' && environment.ORACLE_E2E_BASE_URL === undefined) {
    throw new Error('Hosted evaluator tests require an explicit ORACLE_E2E_BASE_URL.');
  }
  if (rawTarget === 'hosted' && environment.ORACLE_E2E_API_BASE_URL === undefined) {
    throw new Error('Hosted evaluator tests require an explicit ORACLE_E2E_API_BASE_URL.');
  }

  const baseURL = cleanBaseUrl(environment.ORACLE_E2E_BASE_URL ?? LOCAL_BASE_URL, rawTarget);
  const apiBaseURL = cleanBaseUrl(
    environment.ORACLE_E2E_API_BASE_URL ?? 'http://127.0.0.1:4174',
    rawTarget,
  );
  return Object.freeze({
    target: rawTarget,
    baseURL,
    apiBaseURL,
    startLocalServer: rawTarget === 'local' && environment.ORACLE_E2E_SKIP_WEB_SERVER !== '1',
  });
}

export function isHostedTarget(environment: NodeJS.ProcessEnv = process.env): boolean {
  return evaluatorTargetConfiguration(environment).target === 'hosted';
}
