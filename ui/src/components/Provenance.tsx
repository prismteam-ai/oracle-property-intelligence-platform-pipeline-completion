import { COUNTY_LABEL } from '../config';

/**
 * Source attribution line -- provenance is the product, so every result
 * view renders one of these.
 */
export default function Provenance({
  sourceSystems,
}: {
  sourceSystems?: string[];
}) {
  const sources =
    sourceSystems && sourceSystems.length > 0
      ? sourceSystems.join(', ')
      : 'lee_appraiser';
  return (
    <p className="text-xs text-slate-500">
      Source: <span className="font-mono text-slate-600">{sources}</span>
      {' · '}
      {COUNTY_LABEL}
      {' · '}queried live from the on-chain-addressed Parquet table
    </p>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="border border-red-200 bg-red-50 rounded px-4 py-3 text-sm text-red-800">
      <span className="font-medium">Query failed:</span>{' '}
      <span className="font-mono break-all">{message}</span>
      <p className="mt-1 text-xs text-red-600">
        The IPFS gateway rate-limits bursts (HTTP 429). Waiting a few seconds
        and retrying usually resolves it.
      </p>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500 py-3">
      <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
      {label}
    </div>
  );
}
