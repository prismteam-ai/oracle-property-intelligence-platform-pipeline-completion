FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/aws.zip \
    && unzip -q /tmp/aws.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/aws.zip

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ui/ ui/
COPY deploy/fetch-artifacts.sh /app/deploy/fetch-artifacts.sh
RUN chmod +x /app/deploy/fetch-artifacts.sh

ENV DATA_DIR=/app/data \
    PARQUET_PATH=/app/data/properties.parquet \
    RUN_SUMMARY_PATH=/app/data/run_summary.json \
    MANIFEST_PATH=/app/manifest.json \
    WEB_PORT=3000

EXPOSE 3000

CMD ["/bin/bash", "-c", "/app/deploy/fetch-artifacts.sh && exec gunicorn --bind 0.0.0.0:${WEB_PORT} --workers 2 --threads 4 ui.app:app"]
