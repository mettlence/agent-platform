#!/usr/bin/env bash
# One-time EC2 bootstrap for agent-platform (Ubuntu 22.04 / 24.04 LTS).
# Run on the fresh EC2 host as the SSH user.
#
# Usage (on the EC2 host):
#   curl -fsSL https://raw.githubusercontent.com/mettlence/agent-platform/main/scripts/ec2-bootstrap.sh | bash
# Or copy + run directly.

set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:-/opt/agent-platform}"

echo "▸ Updating apt"
sudo apt-get update -y

echo "▸ Installing Docker + Compose plugin + utilities"
sudo apt-get install -y \
  ca-certificates curl gnupg lsb-release ufw nginx wget

if ! command -v docker &> /dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  echo "  ✓ Docker installed"
else
  echo "  ✓ Docker already installed"
fi

echo "▸ Creating $REMOTE_DIR"
sudo mkdir -p "$REMOTE_DIR" "$REMOTE_DIR/logs"
sudo chown -R "$USER:$USER" "$REMOTE_DIR"

echo "▸ Configuring firewall (allow 22/80/443)"
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

echo ""
echo "✅ Bootstrap done."
echo ""
echo "Next steps:"
cat <<'NEXT'
  1. Log out + back in so docker group membership takes effect:
       exit && ssh back in
     Verify with: docker ps    (should not say "permission denied")

  2. Copy .env to /opt/agent-platform/.env (one-time, manual)
       From your laptop:
       scp -i agent.mettlence.com.pem .env ubuntu@<ec2-host>:/opt/agent-platform/.env

  3. Set these GitHub repo secrets (Settings → Secrets and variables → Actions):
       EC2_HOST        — ec2-54-158-25-23.compute-1.amazonaws.com
       EC2_USER        — ubuntu
       EC2_SSH_KEY     — contents of agent.mettlence.com.pem (full file, with headers)

  4. Trigger first deploy by pushing to main (or run "Deploy to EC2" workflow manually).

  5. (Optional) Setup nginx + HTTPS — see scripts/nginx-agent-platform.conf
NEXT
