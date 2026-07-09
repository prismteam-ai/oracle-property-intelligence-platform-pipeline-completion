# Oracle MCP — elephant-mcp HTTP server with the query-table parquet baked in
# locally (DuckDB reads local disk, never the network — the reliability fix).
FROM node:22-slim

WORKDIR /app
# git: npm installs @elephant-xyz/mcp from GitHub (needs git to clone)
# curl: downloads the parquet below
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json start.mjs ./
RUN npm install

# Cache-bust marker — bump this string to force a fresh parquet re-download
# (otherwise Docker reuses the cached curl layer and serves a stale dataset).
RUN echo "parquet-rev: 2026-07-09-owner-reconciliation"

# Bake BOTH counties' parquets into the image so queries never touch the
# network. santa-clara = the correct county (Palo Alto); lee = reference.
RUN curl -fSL --retry 3 -o santa-clara.parquet \
      https://oracle-parquet-host.netlify.app/santa-clara-query-table.parquet \
    && curl -fSL --retry 3 -o lee.parquet \
      https://oracle-parquet-host.netlify.app/lee-query-table.parquet \
    && ls -lh santa-clara.parquet lee.parquet

ENV PORT=8787
EXPOSE 8787
CMD ["node", "start.mjs"]
