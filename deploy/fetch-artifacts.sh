#!/usr/bin/env bash
# Fetch pipeline artifacts before starting a container (S3 or HTTP).
set -euo pipefail

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "${DATA_DIR}"

fetch_one() {
  local dest="$1"
  local s3_uri="$2"
  local http_url="$3"
  if [[ -f "${dest}" && -s "${dest}" ]]; then
    return 0
  fi
  if [[ -n "${s3_uri}" ]]; then
    echo "Fetching ${dest} from ${s3_uri}"
    aws s3 cp "${s3_uri}" "${dest}"
    return 0
  fi
  if [[ -n "${http_url}" ]]; then
    echo "Fetching ${dest} from ${http_url}"
    curl -fsSL "${http_url}" -o "${dest}"
    return 0
  fi
}

fetch_one "${DATA_DIR}/properties.parquet" "${PARQUET_S3_URI:-}" "${PARQUET_URL:-}"
fetch_one "${DATA_DIR}/run_summary.json" "${RUN_SUMMARY_S3_URI:-}" "${RUN_SUMMARY_URL:-}"
if [[ -n "${MANIFEST_S3_URI:-}" ]]; then
  aws s3 cp "${MANIFEST_S3_URI}" /app/manifest.json
elif [[ -n "${MANIFEST_URL:-}" ]]; then
  curl -fsSL "${MANIFEST_URL}" -o /app/manifest.json
fi

if [[ ! -f "${DATA_DIR}/properties.parquet" ]]; then
  echo "ERROR: properties.parquet missing. Set PARQUET_S3_URI or PARQUET_URL." >&2
  exit 1
fi
