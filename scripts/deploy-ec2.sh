#!/usr/bin/env bash
# Deploy agent-platform to an EC2 host via Docker.
# Usage: ./scripts/deploy-ec2.sh <ssh-target>
# Example: ./scripts/deploy-ec2.sh ubuntu@agent.asksabrina.com
#
# Assumes:
#  - target host has Docker + docker compose plugin installed
#  - SSH key already configured
#  - .env file exists locally (copied separately or out-of-band)
#  - target /opt/agent-platform exists and is owned by the SSH user

set -euo pipefail

TARGET="${1:?Usage: deploy-ec2.sh <user@host>}"
REMOTE_DIR="${REMOTE_DIR:-/opt/agent-platform}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "▸ Building tarball (excluding node_modules / dist / .env / logs)"
TARBALL=$(mktemp -t agent-platform-XXXXXX.tar.gz)
trap "rm -f $TARBALL" EXIT

tar -czf "$TARBALL" \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='logs' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.git' \
  -C "$LOCAL_DIR" \
  .

echo "▸ Uploading to $TARGET:$REMOTE_DIR"
ssh "$TARGET" "mkdir -p $REMOTE_DIR"
scp "$TARBALL" "$TARGET:$REMOTE_DIR/release.tar.gz"

echo "▸ Extracting + building + restarting on remote"
ssh "$TARGET" bash <<EOF
  set -euo pipefail
  cd $REMOTE_DIR
  tar -xzf release.tar.gz
  rm -f release.tar.gz

  if [ ! -f .env ]; then
    echo "⚠️  .env missing on remote — copy it manually before first deploy"
    exit 1
  fi

  docker compose build
  docker compose up -d
  docker compose ps
EOF

echo "✅ Deployed."
echo "Logs: ssh $TARGET 'cd $REMOTE_DIR && docker compose logs -f'"
