#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VIDEO_DIR="${SCRIPT_DIR}/demo-video"
OUT_DIR="${PROJECT_ROOT}/demo"

export PATH="${HOME}/.local/node/bin:${PATH}"

echo "== Record Oracle PR demo video =="

if ! curl -sf "http://127.0.0.1:3000/" >/dev/null 2>&1; then
  echo "Starting UI on port 3000..."
  python3 "${PROJECT_ROOT}/ui/app.py" >/tmp/oracle-ui-demo.log 2>&1 &
  UI_PID=$!
  for _ in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:3000/" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  if ! curl -sf "http://127.0.0.1:3000/" >/dev/null 2>&1; then
    echo "FAIL UI did not start"
    exit 1
  fi
  echo "OK  UI started (pid ${UI_PID})"
else
  echo "OK  UI already running"
  UI_PID=""
fi

cd "${VIDEO_DIR}"
if [[ ! -d node_modules/playwright ]]; then
  echo "Installing Playwright..."
  npm install --no-fund --no-audit
  npx playwright install chromium
fi

mkdir -p "${OUT_DIR}"
node record.mjs "http://127.0.0.1:3000" "${OUT_DIR}"

if [[ -n "${UI_PID}" ]]; then
  kill "${UI_PID}" 2>/dev/null || true
fi

echo
echo "Demo video: ${OUT_DIR}/oracle-property-intelligence-demo.webm"
