#!/usr/bin/env bash
set -euo pipefail

PATH_LINE='export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"'
BASHRC="${HOME}/.bashrc"

if [[ -f "${BASHRC}" ]] && grep -qF '.local/node/bin' "${BASHRC}"; then
  echo "OK  PATH already configured in ${BASHRC}"
  exit 0
fi

echo "Adding Node/npm PATH to ${BASHRC}..."
{
  echo
  echo '# Oracle Property Intelligence — local Node 22 + pip tools'
  echo "${PATH_LINE}"
} >> "${BASHRC}"

echo "Done. Run: source ${BASHRC}"
echo "Then reload Cursor so Elephant MCP can use Node 22."
