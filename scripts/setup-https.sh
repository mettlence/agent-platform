#!/usr/bin/env bash
# Idempotent HTTPS setup for agent-platform on Ubuntu (EC2).
# Run on the EC2 host as the SSH user (uses sudo). Safe to re-run.
#
# Prereqs:
#  - DNS A record for $DOMAIN points at this host
#  - nginx already installed (scripts/ec2-bootstrap.sh handles that)
#  - The app listens on 127.0.0.1:3000 (via docker compose)
#
# Usage:
#   ./scripts/setup-https.sh
#   DOMAIN=other.host.com EMAIL=you@example.com ./scripts/setup-https.sh

set -euo pipefail

DOMAIN="${DOMAIN:-agent.mettlence.com}"
EMAIL="${EMAIL:-mettlence.dev@gmail.com}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_SRC="$SCRIPT_DIR/nginx-agent-platform.conf"
NGINX_AVAIL="/etc/nginx/sites-available/agent-platform"
NGINX_ENABLED="/etc/nginx/sites-enabled/agent-platform"
ACME_WEBROOT="/var/www/certbot"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

echo "▸ Domain: $DOMAIN"
echo "▸ Email:  $EMAIL"

# ─── 1. Install certbot if missing ────────────────────────────────────────
if ! command -v certbot &> /dev/null; then
  echo "▸ Installing certbot + nginx plugin"
  sudo apt-get update -y
  sudo apt-get install -y certbot python3-certbot-nginx
else
  echo "  ✓ certbot already installed"
fi

# ─── 2. Disable default nginx site (avoid server_name collisions) ─────────
if [ -L /etc/nginx/sites-enabled/default ]; then
  echo "▸ Removing default nginx site"
  sudo rm -f /etc/nginx/sites-enabled/default
fi

# ─── 3. First-time cert issuance via webroot ──────────────────────────────
if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  echo "▸ No cert found — issuing via webroot challenge"
  sudo mkdir -p "$ACME_WEBROOT"

  # Temporary HTTP-only site so certbot can complete the ACME challenge.
  # Removed once the cert is in place and the final config is installed.
  ACME_CONF="/etc/nginx/sites-available/agent-platform-acme"
  sudo tee "$ACME_CONF" > /dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
    }

    location / {
        return 404;
    }
}
EOF
  sudo ln -sf "$ACME_CONF" /etc/nginx/sites-enabled/agent-platform-acme
  sudo nginx -t
  sudo systemctl reload nginx

  sudo certbot certonly --webroot -w "$ACME_WEBROOT" \
    -d "$DOMAIN" -m "$EMAIL" --agree-tos -n

  sudo rm -f /etc/nginx/sites-enabled/agent-platform-acme "$ACME_CONF"
else
  echo "  ✓ Cert already exists at $CERT_DIR"
fi

# ─── 4. Install final nginx site (HTTP redirect + HTTPS proxy) ────────────
echo "▸ Installing nginx site config"
sudo cp "$NGINX_SRC" "$NGINX_AVAIL"
sudo ln -sf "$NGINX_AVAIL" "$NGINX_ENABLED"

sudo nginx -t
sudo systemctl reload nginx

# ─── 5. Ensure auto-renewal timer is active ───────────────────────────────
sudo systemctl enable --now certbot.timer

echo ""
echo "✅ HTTPS ready: https://$DOMAIN"
echo "   Renewal:    sudo systemctl status certbot.timer"
echo "   Dry-run:    sudo certbot renew --dry-run"
