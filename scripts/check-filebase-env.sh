#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

if [[ -z "${S3_ACCESS_KEY_ID}" || -z "${S3_SECRET_ACCESS_KEY}" || -z "${S3_BUCKET}" ]]; then
  echo "Filebase credentials missing in .env"
  echo "Fill: S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"
  echo "Then re-run this script."
  exit 1
fi

echo "== Filebase / IPFS env check =="
echo "  S3_ENDPOINT=${S3_ENDPOINT}"
echo "  S3_BUCKET=${S3_BUCKET}"
echo "  FILEBASE_IPNS_LABEL=${FILEBASE_IPNS_LABEL}"
echo "  IPFS_GATEWAY=${IPFS_GATEWAY}"
echo
echo "Use elephant-xyz skill: county-open-data-publish"
echo "Human must approve PII upload to public IPFS per skill contract."
