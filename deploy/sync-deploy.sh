#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="/mnt/media/services/newsletter-digest"
DEPLOY_SRC="$REPO_DIR/deploy/docker-compose.yml"
APPLY=0

run() {
  printf '+ %q' "$@"
  printf '\n'
  if [[ "$APPLY" -eq 1 ]]; then
    "$@"
  fi
}

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [[ "$APPLY" -eq 1 ]]; then
  echo "Applying tracked deploy config from $REPO_DIR"
else
  echo "Previewing tracked deploy sync from $REPO_DIR"
  echo "Re-run with --apply to execute these commands."
fi

run mkdir -p "$RUNTIME_DIR"
run cp "$DEPLOY_SRC" "$RUNTIME_DIR/docker-compose.yml"
run cp "$REPO_DIR/.env.example" "$RUNTIME_DIR/.env.example"

if [[ "$APPLY" -eq 1 ]]; then
  echo "Done copying tracked deploy config."
  echo "Keep using the local $RUNTIME_DIR/.env for secrets and runtime overrides."
fi

echo "Done."
