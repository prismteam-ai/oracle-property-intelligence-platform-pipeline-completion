#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-all}" in
  setup)
    exec "${SCRIPT_DIR}/setup-environment.sh"
    ;;
  check)
    exec "${SCRIPT_DIR}/check-tools.sh"
    ;;
  status)
    exec "${SCRIPT_DIR}/status.sh"
    ;;
  fix)
    exec "${SCRIPT_DIR}/fix-missing.sh"
    ;;
  manual)
    exec "${SCRIPT_DIR}/manual-steps.sh"
    ;;
  test)
    exec "${SCRIPT_DIR}/run-acceptance-tests.sh" "${@:2}"
    ;;
  mcp)
    exec "${SCRIPT_DIR}/verify-elephant-mcp.sh"
    ;;
  mcp-start)
    exec "${SCRIPT_DIR}/start-local-mcp.sh"
    ;;
  mcp-clone)
    exec "${SCRIPT_DIR}/clone-elephant-mcp.sh"
    ;;
  mcp-build)
    exec "${SCRIPT_DIR}/build-elephant-mcp.sh"
    ;;
  skills)
    exec "${SCRIPT_DIR}/install-elephant-skills.sh"
    ;;
  gh)
    exec "${SCRIPT_DIR}/auth-github.sh"
    ;;
  db)
    exec "${SCRIPT_DIR}/pull-database-url.sh"
    ;;
  filebase)
    exec "${SCRIPT_DIR}/check-filebase-env.sh"
    ;;
  filebase-fill)
    exec "${SCRIPT_DIR}/fill-filebase-env.sh"
    ;;
  path)
    exec "${SCRIPT_DIR}/setup-bashrc-path.sh"
    ;;
  cursor)
    exec "${SCRIPT_DIR}/setup-cursor-mcp.sh"
    ;;
  data)
    exec "${SCRIPT_DIR}/init-data-dirs.sh"
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
  docker)
    exec docker compose -f "${SCRIPT_DIR}/../docker-compose.yml" up --build "${@:2}"
    ;;
  deploy-aws)
    exec "${SCRIPT_DIR}/deploy-aws.sh"
    ;;
  record-demo)
    exec "${SCRIPT_DIR}/record-demo-video.sh"
    ;;
  servers)
    exec "${SCRIPT_DIR}/check-servers.sh"
    ;;
  cursor-mcp-test)
    exec "${SCRIPT_DIR}/test-cursor-elephant-mcp.sh" "${@:2}"
    ;;
  cursor-mcp-fix)
    exec "${SCRIPT_DIR}/fix-cursor-elephant-mcp.sh"
    ;;
  all|*)
    "${SCRIPT_DIR}/setup-environment.sh"
    "${SCRIPT_DIR}/fix-missing.sh" || true
    "${SCRIPT_DIR}/status.sh"
    ;;
esac
