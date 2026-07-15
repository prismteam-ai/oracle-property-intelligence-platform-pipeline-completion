#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.local/node/bin:${HOME}/.local/bin:/usr/bin:/bin"
NPX="${HOME}/.local/node/bin/npx"
NODE="${HOME}/.local/node/bin/node"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${PROJECT_ROOT}/config/elephant-mcp.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/config/elephant-mcp.env"
  set +a
fi

MCP_DIR="$(cd "${PROJECT_ROOT}/.." && pwd)/elephant-mcp"
ENTRY="${MCP_DIR}/dist/index.js"

# Empty AWS_PROFILE crashes elephant-mcp zod validation — unset if blank.
if [[ -z "${AWS_PROFILE:-}" ]]; then
  unset AWS_PROFILE
fi

if [[ -f "${ENTRY}" ]]; then
  cd "${MCP_DIR}"
  exec "${NODE}" "${ENTRY}"
fi

if [[ ! -x "${NPX}" ]]; then
  echo "elephant-mcp-launch: missing ${NPX}. Run ./scripts/setup-environment.sh" >&2
  exit 1
fi

exec "${NPX}" -y --package="${ELEPHANT_MCP_PACKAGE:-github:elephant-xyz/elephant-mcp#main}" mcp
