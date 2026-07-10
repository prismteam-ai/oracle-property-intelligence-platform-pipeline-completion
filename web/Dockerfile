# Oracle Property Intelligence — Next.js UI
# Self-contained: reads the static properties.parquet (in public/data), queries
# it client-side via DuckDB-WASM, and calls Anthropic for the agent at runtime.
FROM node:20-alpine

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm ci

# App source (the parquet is NOT in the repo — fetched below).
COPY . .

# Fetch the query dataset from the cloud bucket (Filebase/IPFS by default;
# override with DATA_URL build arg / env for GCS).
RUN npm run fetch-data

# Build the production bundle. Runtime secrets are injected via env at run time,
# not baked into the image.
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3100
EXPOSE 3100

CMD ["npm", "run", "start"]
