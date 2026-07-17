import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { useApiQuery } from './api.js';
import type { ApiClient, QueryState } from './types.js';

type OracleContextValue = Readonly<{
  client: ApiClient;
  release: QueryState & Readonly<{ retry: () => void }>;
  releaseId: string | null;
}>;

const OracleContext = createContext<OracleContextValue | null>(null);

export function OracleProvider({
  client,
  children,
  testFixtureLabel,
}: Readonly<{ client: ApiClient; children: ReactNode; testFixtureLabel?: string }>) {
  const release = useApiQuery(client, 'dataset.getInfo', {});
  const releaseId = release.status === 'success' ? release.data.releaseId : null;
  const value = useMemo(() => ({ client, release, releaseId }), [client, release, releaseId]);
  return (
    <OracleContext.Provider value={value}>
      {testFixtureLabel === undefined ? null : (
        <div className="test-fixture-banner" role="status">
          {testFixtureLabel} · Test-only deterministic data
        </div>
      )}
      {children}
    </OracleContext.Provider>
  );
}

export function useOracle(): OracleContextValue {
  const value = useContext(OracleContext);
  if (value === null) throw new Error('OracleProvider is missing');
  return value;
}
