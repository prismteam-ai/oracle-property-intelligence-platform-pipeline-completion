#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

echo "== Manual steps =="
echo
echo "1. Shell PATH (one time)"
echo "   Run: ./scripts/run.sh path"
echo "   Or add to ~/.bashrc:"
echo '   export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"'
echo "   Then: source ~/.bashrc"
echo
echo "2. Cursor + Elephant MCP (one time)"
echo "   - Reload Cursor after PATH update"
echo "   - Settings → MCP → enable server: ${ELEPHANT_MCP_SERVER}"
echo "   - Requires Node 22+ on PATH for Cursor"
echo "   - Do NOT set empty OPENAI_API_KEY on elephant MCP"
echo
echo "3. GitHub auth (when pushing or using gh)"
echo "   Run: ./scripts/auth-github.sh"
echo
echo "4. Filebase keys (for IPFS publish — county-open-data-publish skill)"
echo "   Run: ./scripts/run.sh filebase-fill"
echo "   Or fill in .env manually:"
echo "     S3_BUCKET"
echo "     S3_ACCESS_KEY_ID"
echo "     S3_SECRET_ACCESS_KEY"
echo
echo "5. Neon DATABASE_URL (optional — use-elephant-query-db skill)"
echo "   Run: ./scripts/pull-database-url.sh"
echo
echo "6. AWS_PROFILE (optional — only for full onboard-county AWS deploy)"
echo "   Leave blank if using tools without AWS deploy"
echo
echo "7. Verify Cursor ↔ Elephant MCP"
echo "   ./scripts/run.sh cursor-mcp-test"
echo
echo "8. Run acceptance tests"
echo "   ./scripts/run-acceptance-tests.sh"
echo
echo "9. Start local MCP (for dev)"
echo "   ./scripts/start-local-mcp.sh"
echo
echo "10. County discovery (Elephant Oracle Skills)"
echo "    In Cursor, invoke skill: county-discovery for Santa Clara County, CA"
echo "    Or from oracle-node: cd ${PROJECT_ROOT}/${ORACLE_NODE_DIR}"
