FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e

WORKDIR /workspace

ENV COREPACK_HOME=/opt/corepack-cache
ENV PATH=/opt/corepack/node_modules/.bin:$PATH

RUN npm install --prefix /opt/corepack --no-audit --no-fund corepack@0.34.6 \
  && corepack install --global pnpm@10.33.0

COPY . .

RUN test "$(node --version)" = "v22.18.0" \
  && test "$(corepack --version)" = "0.34.6" \
  && test "$(pnpm --version)" = "10.33.0" \
  && pnpm install --frozen-lockfile \
  && pnpm verify

CMD ["pnpm", "--filter", "@oracle/pipeline", "check"]
