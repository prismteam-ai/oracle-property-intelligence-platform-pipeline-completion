#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

echo "== Acceptance tests =="
cd "${PROJECT_ROOT}"
python3 -m pytest tests/acceptance -v "$@"
