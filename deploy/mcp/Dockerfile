FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/aws.zip \
    && unzip -q /tmp/aws.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/aws.zip

WORKDIR /app

COPY mcp/package.json mcp/start.mjs ./
RUN npm install --omit=dev

COPY deploy/fetch-artifacts.sh /app/deploy/fetch-artifacts.sh
RUN chmod +x /app/deploy/fetch-artifacts.sh

ENV DATA_DIR=/app/data \
    PARQUET_PATH=/app/data/properties.parquet \
    COUNTY=santa-clara \
    MCP_PORT=8000 \
    PORT=8000

EXPOSE 8000

CMD ["/bin/bash", "-c", "/app/deploy/fetch-artifacts.sh && exec node start.mjs"]
