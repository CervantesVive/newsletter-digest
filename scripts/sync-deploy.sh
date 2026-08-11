#!/usr/bin/env bash
# Sync tracked deploy config from this repo into the runtime directory.
#
# NOTE: the runtime docker-compose.yml has pre-existing drift from
# deploy/docker-compose.yml (a pinned image tag instead of :latest, and a
# Tailscale-only port binding instead of 3000:3000) — this script will
# overwrite that drift on every run. Reconcile deploy/docker-compose.yml
# with the live customization before relying on --apply here, or hand-edit
# the runtime file back afterward.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="/mnt/media/services/newsletter-digest"
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
  echo "Applying tracked config from $REPO_DIR"
else
  echo "Previewing tracked config sync from $REPO_DIR"
  echo "Re-run with --apply to execute these commands."
fi

run mkdir -p "$RUNTIME_DIR"
run cp "$REPO_DIR/deploy/docker-compose.yml" "$RUNTIME_DIR/docker-compose.yml"
run cp "$REPO_DIR/.env.example" "$RUNTIME_DIR/.env.example"

if [[ "$APPLY" -eq 1 ]]; then
  echo "Done copying tracked config."
  echo "Keep using the live $RUNTIME_DIR/.env for secrets."
fi

run bash -c "cd '$RUNTIME_DIR' && docker compose pull && docker compose up -d"

echo "Done."
