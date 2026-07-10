export interface RunReport {
  generatedAt: string;
  county: string;
  focus: string;
  bbox: number[];
  grandTotalRecords: number;
  runs: Array<{
    connector: string;
    source: string;
    entity: string;
    count: number;
    sourceUrl: string;
    startedAt: string;
    finishedAt: string;
    notes: string[];
  }>;
  dbTotals: Array<{ entity: string; source: string; records: number }>;
  constraints: Array<{
    source: string;
    status: string;
    detail: string;
    affects: string[];
    catalog?: string;
  }>;
}

export interface Manifest {
  generatedAt: string;
  county: string;
  focus: string;
  provider: string;
  artifacts: Array<{
    file: string;
    key: string;
    rows: number;
    bytes: number;
    cid: string;
    gateway: string;
  }>;
  propertyQueryTableMap: Record<string, string>;
  note: string;
}
