#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  setup)
    exec "${SCRIPT_DIR}/setup-environment.sh"
    ;;
  test)
    exec "${SCRIPT_DIR}/run-acceptance-tests.sh" "${@:2}"
    ;;
  pipeline)
    exec "${SCRIPT_DIR}/run-pipeline.sh" "${@:2}"
    ;;
  ui-start)
    exec "${SCRIPT_DIR}/start-ui.sh"
    ;;
  ui-mcp-start)
    exec "${SCRIPT_DIR}/start-project-mcp.sh"
    ;;
  servers)
    exec "${SCRIPT_DIR}/check-servers.sh"
    ;;
  deploy-aws)
    exec "${SCRIPT_DIR}/deploy-aws.sh"
    ;;
  docker)
    exec docker compose -f "${SCRIPT_DIR}/../docker-compose.yml" up --build "${@:2}"
    ;;
  cursor-mcp-fix)
    exec "${SCRIPT_DIR}/fix-cursor-elephant-mcp.sh"
    ;;
  data)
    exec "${SCRIPT_DIR}/init-data-dirs.sh"
    ;;
  *)
    echo "Usage: ./scripts/run.sh <command>"
    echo
    echo "Commands:"
    echo "  setup          Install Python + MCP npm dependencies"
    echo "  pipeline       Build data/properties.parquet"
    echo "  ui-start       Start Flask UI on :3000"
    echo "  ui-mcp-start   Start elephant-mcp HTTP on :8000"
    echo "  servers        Check UI and MCP ports"
    echo "  test           Run acceptance tests"
    echo "  deploy-aws     Deploy to AWS (optional)"
    echo "  docker         Local Docker smoke test"
    echo "  cursor-mcp-fix Generate .mcp.json for Cursor"
    echo "  data           Create data/ directories"
    exit 1
    ;;
esac
