#!/usr/bin/env bash
set -euo pipefail

echo "== GitHub authentication =="
echo "Your gh token is expired or missing."
echo
echo "Run this command and follow the prompts:"
echo "  gh auth login -h github.com"
echo
echo "Then verify:"
echo "  gh auth status"

if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    echo
    echo "gh is already authenticated."
    gh auth status
    exit 0
  fi
fi

read -r -p "Open gh auth login now? [y/N] " answer
if [[ "${answer}" =~ ^[Yy]$ ]]; then
  gh auth login -h github.com
fi
