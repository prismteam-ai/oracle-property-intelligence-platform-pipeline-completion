#!/usr/bin/env bash
set -euo pipefail

release_relative_directory="$1"
test "$(node --version)" = "v22.18.0"
test "$(pnpm --version)" = "10.33.0"
test "$(esbuild --version)" = "0.28.1"

rm -rf /tmp/oracle-bundle
mkdir -p /tmp/oracle-bundle
cp \
  /asset-input/package.json \
  /asset-input/pnpm-lock.yaml \
  /asset-input/pnpm-workspace.yaml \
  /tmp/oracle-bundle/

while IFS= read -r -d '' manifest; do
  relative="${manifest#/asset-input/}"
  mkdir -p "/tmp/oracle-bundle/$(dirname "$relative")"
  cp "$manifest" "/tmp/oracle-bundle/$relative"
done < <(find /asset-input/apps /asset-input/packages /asset-input/infra -name package.json -type f -print0)
cp /asset-input/packages/tsconfig/*.json /tmp/oracle-bundle/packages/tsconfig/

cd /tmp/oracle-bundle
pnpm \
  --filter @oracle/api... \
  --filter @oracle/mcp... \
  install \
  --frozen-lockfile \
  --ignore-scripts

common_esbuild_arguments=(
  --bundle
  --tsconfig=/tmp/oracle-bundle/packages/tsconfig/node.json
  --target=node22
  --platform=node
  --format=esm
  "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  --minify
  --sourcemap
  --external:@duckdb/node-api
  --main-fields=module,main
  --alias:@aws-lambda-powertools/logger=/tmp/oracle-bundle/packages/observability/node_modules/@aws-lambda-powertools/logger
  --alias:@aws-lambda-powertools/metrics=/tmp/oracle-bundle/packages/observability/node_modules/@aws-lambda-powertools/metrics
  --alias:@aws-lambda-powertools/tracer=/tmp/oracle-bundle/packages/observability/node_modules/@aws-lambda-powertools/tracer
  --alias:@oracle/artifacts=/asset-input/packages/artifacts/src
  --alias:@oracle/contracts=/asset-input/packages/contracts/src
  --alias:@oracle/data-runtime=/asset-input/packages/data-runtime/src
  --alias:@oracle/features=/asset-input/packages/features/src
  --alias:@oracle/observability=/asset-input/packages/observability/src/index.ts
  --alias:@oracle/query-core=/asset-input/packages/query-core/src
  --alias:zod=/tmp/oracle-bundle/packages/contracts/node_modules/zod
)

esbuild \
  /asset-input/apps/api/src/handler.ts \
  "${common_esbuild_arguments[@]}" \
  --outfile=/asset-output/api.mjs

esbuild \
  /asset-input/apps/mcp/src/handler.ts \
  "${common_esbuild_arguments[@]}" \
  --alias:@modelcontextprotocol/sdk=/tmp/oracle-bundle/apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm \
  --outfile=/asset-output/mcp.mjs

mkdir -p /asset-output/node_modules/@duckdb
api=/tmp/oracle-bundle/packages/data-runtime/node_modules/@duckdb/node-api
bindings=$(find /tmp/oracle-bundle/node_modules/.pnpm -path '*/node_modules/@duckdb/node-bindings' -type d -print -quit)
native=$(find /tmp/oracle-bundle/node_modules/.pnpm -path '*/node_modules/@duckdb/node-bindings-linux-x64' -type d -print -quit)
for package in "$api" "$bindings" "$native"; do
  test -d "$package" || {
    echo 'Missing exact DuckDB Linux x64 dependency closure' >&2
    exit 1
  }
  cp -aL "$package" /asset-output/node_modules/@duckdb/
done

mkdir -p /asset-output/release
cp -a "/asset-input/$release_relative_directory/." /asset-output/release/

node --input-type=module --eval "
  import { readFileSync } from 'node:fs';
  const root = '/asset-output/node_modules/@duckdb';
  const expected = new Map([
    ['node-api', '1.4.5-r.1'],
    ['node-bindings', '1.4.5-r.1'],
    ['node-bindings-linux-x64', '1.4.5-r.1'],
  ]);
  for (const [name, version] of expected) {
    const manifest = JSON.parse(readFileSync(root + '/' + name + '/package.json', 'utf8'));
    if (manifest.name !== '@duckdb/' + name || manifest.version !== version) {
      throw new Error('DuckDB package identity mismatch: ' + name);
    }
  }
"

if find /asset-output/node_modules/@duckdb -maxdepth 2 -type d \
  \( -name '*darwin*' -o -name '*win32*' -o -name '*arm64*' \) \
  -print -quit | grep -q .; then
  echo 'Unsupported DuckDB binary package in Lambda asset' >&2
  exit 1
fi
