#!/usr/bin/env bash
set -Eeuo pipefail

SWIFT_REPO_URL="${SWIFT_REPO_URL:-https://github.com/bengs777/SW.git}"
SWIFT_RUNTIME_DIR="${SWIFT_RUNTIME_DIR:-/root/swift-runtime}"
SWIFT_SANDBOX_DOMAIN="${SWIFT_SANDBOX_DOMAIN:-sandbox.ai-swift.biz.id}"
SWIFT_SANDBOX_ROOT="${SWIFT_SANDBOX_ROOT:-/data/swift-sandbox}"
SWIFT_CONFIGURE_UFW="${SWIFT_CONFIGURE_UFW:-1}"
SWIFT_INSTALL_CERTBOT_CERT="${SWIFT_INSTALL_CERTBOT_CERT:-0}"
SWIFT_CERTBOT_EMAIL="${SWIFT_CERTBOT_EMAIL:-}"

log() {
  printf '[swift-bootstrap] %s\n' "$*"
}

die() {
  printf '[swift-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    die "run this script as root on the VPS"
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

install_packages() {
  log "installing base packages"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    certbot \
    curl \
    fail2ban \
    git \
    jq \
    nginx \
    python3-certbot-nginx \
    ufw \
    unzip
}

install_node() {
  local major=""
  if command_exists node; then
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
  fi

  if [ "$major" != "22" ]; then
    log "installing Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  else
    log "Node.js 22 already installed"
  fi

  if ! command_exists pm2; then
    log "installing PM2"
    npm install -g pm2
  fi

  pm2 startup systemd -u root --hp /root >/dev/null || true
}

clone_or_update_repo() {
  if [ -d "$SWIFT_RUNTIME_DIR/.git" ]; then
    log "updating existing repo at $SWIFT_RUNTIME_DIR"
    git -C "$SWIFT_RUNTIME_DIR" pull --ff-only origin main
  else
    log "cloning repo into $SWIFT_RUNTIME_DIR"
    git clone "$SWIFT_REPO_URL" "$SWIFT_RUNTIME_DIR"
  fi
}

install_dependencies() {
  log "installing app dependencies"
  cd "$SWIFT_RUNTIME_DIR"
  npm ci
  npm --prefix services/sandbox-runtime ci --omit=dev
  npx prisma generate
}

ensure_env_files() {
  cd "$SWIFT_RUNTIME_DIR"

  if [ ! -f .env ]; then
    log "creating placeholder .env"
    install -m 600 /dev/null .env
    cat > .env <<'ENV'
# Fill this file on the VPS only. Do not commit it.
NODE_ENV=production
DATABASE_URL=
DIRECT_DATABASE_URL=
REDIS_URL=
AGENTROUTER_API_KEY=
AGENTROUTER_BASE_URL=
AGENTROUTER_MODEL=
SWIFT_AI_PROVIDER_NAME=agentrouter
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=
NEXTAUTH_SECRET=
NEXTAUTH_URL=https://www.ai-swift.biz.id
NEXT_PUBLIC_APP_URL=https://www.ai-swift.biz.id
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=
ENV
    chmod 600 .env
  fi

  if [ ! -f .env.sandbox ]; then
    log "creating placeholder .env.sandbox"
    install -m 600 /dev/null .env.sandbox
    cat > .env.sandbox <<ENV
# Fill this file on the VPS only. Do not commit it.
NODE_ENV=production
PORT=8080
HOST=0.0.0.0
SANDBOX_PUBLIC_BASE_URL=https://${SWIFT_SANDBOX_DOMAIN}
SANDBOX_SERVICE_TOKEN=
SWIFT_SANDBOX_ROOT=${SWIFT_SANDBOX_ROOT}
SWIFT_SANDBOX_BASE_PORT=4300
SWIFT_SANDBOX_MAX_PROJECTS=12
SWIFT_SANDBOX_MAX_FILES=240
SWIFT_SANDBOX_MAX_TOTAL_BYTES=6291456
SWIFT_SANDBOX_MIN_FREE_BYTES=268435456
SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS=1800000
SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS=1200000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=
ENV
    chmod 600 .env.sandbox
  fi
}

configure_storage() {
  log "preparing sandbox storage at $SWIFT_SANDBOX_ROOT"
  mkdir -p "$SWIFT_SANDBOX_ROOT"
  chmod 700 "$SWIFT_SANDBOX_ROOT"
}

configure_firewall() {
  if [ "$SWIFT_CONFIGURE_UFW" != "1" ]; then
    log "skipping UFW configuration"
    return
  fi

  log "configuring UFW for SSH/HTTP/HTTPS"
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
}

configure_nginx() {
  log "configuring nginx for $SWIFT_SANDBOX_DOMAIN"
  cat > /etc/nginx/sites-available/swift-sandbox <<NGINX
server {
    listen 80;
    server_name ${SWIFT_SANDBOX_DOMAIN};

    client_max_body_size 10m;

    location = /worker/health {
        proxy_pass http://127.0.0.1:4000/health;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/swift-sandbox /etc/nginx/sites-enabled/swift-sandbox
  nginx -t
  systemctl reload nginx
}

maybe_install_certificate() {
  if [ "$SWIFT_INSTALL_CERTBOT_CERT" != "1" ]; then
    log "skipping certbot issuance; run certbot after DNS points to this VPS"
    return
  fi

  if [ -z "$SWIFT_CERTBOT_EMAIL" ]; then
    die "set SWIFT_CERTBOT_EMAIL before enabling SWIFT_INSTALL_CERTBOT_CERT=1"
  fi

  log "requesting HTTPS certificate for $SWIFT_SANDBOX_DOMAIN"
  certbot --nginx -d "$SWIFT_SANDBOX_DOMAIN" --non-interactive --agree-tos -m "$SWIFT_CERTBOT_EMAIL"
  certbot renew --dry-run
}

print_next_steps() {
  cat <<NEXT

[swift-bootstrap] bootstrap finished.

Next:
1. Fill $SWIFT_RUNTIME_DIR/.env and $SWIFT_RUNTIME_DIR/.env.sandbox with production values.
2. Generate a fresh SANDBOX_SERVICE_TOKEN with:
   openssl rand -hex 32
3. Run:
   cd $SWIFT_RUNTIME_DIR
   bash scripts/vps-production-deploy.sh
4. Set the same SANDBOX_SERVICE_TOKEN and sandbox URLs in Vercel Production.

NEXT
}

main() {
  require_root
  install_packages
  install_node
  clone_or_update_repo
  install_dependencies
  ensure_env_files
  configure_storage
  configure_firewall
  configure_nginx
  maybe_install_certificate
  print_next_steps
}

main "$@"
