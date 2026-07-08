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

# Bake the parquet into the image so queries never touch the network.
RUN curl -fSL --retry 3 -o data.parquet \
      https://oracle-parquet-host.netlify.app/lee-query-table.parquet \
    && ls -lh data.parquet

ENV PORT=8787
EXPOSE 8787
CMD ["node", "start.mjs"]
