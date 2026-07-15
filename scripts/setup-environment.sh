#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

NODE_MIN="22.18.0"
NODE_DIR="${HOME}/.local/node"

echo "== Oracle Property Intelligence — environment setup =="
echo "Project: ${PROJECT_ROOT}"
echo

mkdir -p "${PROJECT_ROOT}/data" "${PROJECT_ROOT}/config"

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//')" < "${NODE_MIN}" ]]; then
  echo "Installing Node.js ${NODE_MIN} to ${NODE_DIR}..."
  mkdir -p "${NODE_DIR}"
  tmp="${NODE_DIR}/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_MIN}/node-v${NODE_MIN}-linux-x64.tar.xz" -o "${tmp}"
  tar -xf "${tmp}" -C "${NODE_DIR}" --strip-components=1
  rm -f "${tmp}"
fi

if ! python3 -m pip --version >/dev/null 2>&1; then
  echo "Installing pip for current user..."
  curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
  python3 /tmp/get-pip.py --user -q
fi

echo "Installing Python test dependencies..."
python3 -m pip install --user -q -r "${PROJECT_ROOT}/requirements-dev.txt"

if [[ ! -d "${PROJECT_ROOT}/${ORACLE_NODE_DIR}/.git" ]]; then
  echo "Cloning oracle-node sibling repos..."
  parent="$(cd "${PROJECT_ROOT}/.." && pwd)"
  for repo in oracle-node elephant-query-db Counties-trasform-scripts; do
    if [[ ! -d "${parent}/${repo}/.git" ]]; then
      git clone "https://github.com/elephant-xyz/${repo}.git" "${parent}/${repo}"
    fi
  done
fi

if [[ ! -d "${PROJECT_ROOT}/${ORACLE_NODE_DIR}/.agents/skills/onboard-county" ]]; then
  echo "Installing elephant-xyz skills into oracle-node..."
  (cd "${PROJECT_ROOT}/${ORACLE_NODE_DIR}" && npx skills add elephant-xyz/skills --all -y)
fi

if ! grep -q '.local/node/bin' "${HOME}/.bashrc" 2>/dev/null; then
  echo
  echo "Add this line to ~/.bashrc (manual):"
  echo 'export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"'
fi

echo
echo "Setup complete. Next:"
echo "  ./scripts/check-tools.sh"
echo "  ./scripts/manual-steps.sh"
