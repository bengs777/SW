#!/usr/bin/env bash
set -Eeuo pipefail

SWIFT_RUNTIME_DIR="${SWIFT_RUNTIME_DIR:-/root/swift-runtime}"
SWIFT_SANDBOX_DOMAIN="${SWIFT_SANDBOX_DOMAIN:-sandbox.ai-swift.biz.id}"
SWIFT_SKIP_GIT_PULL="${SWIFT_SKIP_GIT_PULL:-0}"
SWIFT_SKIP_PUBLIC_HEALTH="${SWIFT_SKIP_PUBLIC_HEALTH:-0}"

log() {
  printf '[swift-deploy] %s\n' "$*"
}

die() {
  printf '[swift-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

env_has_value() {
  local file="$1"
  local key="$2"
  grep -Eq "^${key}=.+" "$file" && ! grep -Eq "^${key}=($|<|your|replace|placeholder)" "$file"
}

require_env_keys() {
  local file="$1"
  shift
  local missing=()

  [ -f "$file" ] || die "$file is missing"

  for key in "$@"; do
    if ! env_has_value "$file" "$key"; then
      missing+=("$key")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    printf '[swift-deploy] Missing or placeholder values in %s:\n' "$file" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    exit 1
  fi
}

check_env() {
  log "checking env files without printing secret values"
  require_env_keys "$SWIFT_RUNTIME_DIR/.env" \
    DATABASE_URL \
    DIRECT_DATABASE_URL \
    REDIS_URL \
    AGENTROUTER_API_KEY \
    AGENTROUTER_MODEL \
    SWIFT_AI_PROVIDER_NAME \
    SWIFT_GENERATION_EXECUTION_MODE \
    SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK \
    SANDBOX_SERVICE_URL \
    SANDBOX_SERVICE_TOKEN \
    NEXTAUTH_SECRET \
    NEXTAUTH_URL \
    NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY \
    SUPABASE_SERVICE_ROLE_KEY \
    SUPABASE_STORAGE_BUCKET

  require_env_keys "$SWIFT_RUNTIME_DIR/.env.sandbox" \
    PORT \
    HOST \
    SANDBOX_PUBLIC_BASE_URL \
    SANDBOX_SERVICE_TOKEN \
    SWIFT_SANDBOX_ROOT
}

update_repo() {
  cd "$SWIFT_RUNTIME_DIR"
  if [ "$SWIFT_SKIP_GIT_PULL" = "1" ]; then
    log "skipping git pull"
    return
  fi

  log "pulling latest main"
  git pull --ff-only origin main
}

install_dependencies() {
  cd "$SWIFT_RUNTIME_DIR"
  log "installing dependencies"
  npm ci
  npm --prefix services/sandbox-runtime ci --omit=dev
  npx prisma generate
}

restart_services() {
  cd "$SWIFT_RUNTIME_DIR"
  log "starting/restarting PM2 services"
  if pm2 describe swift-generation-worker >/dev/null 2>&1; then
    pm2 restart swift-generation-worker --update-env
  else
    pm2 start ecosystem.config.cjs --only swift-generation-worker --update-env
  fi

  if pm2 describe swift-sandbox >/dev/null 2>&1; then
    pm2 restart swift-sandbox --update-env
  else
    pm2 start ecosystem.config.cjs --only swift-sandbox --update-env
  fi

  pm2 save
  pm2 status
}

health_check() {
  local label="$1"
  local url="$2"

  log "checking $label: $url"
  curl --fail --silent --show-error --max-time 20 "$url" >/tmp/swift-health.json
  if command -v jq >/dev/null 2>&1; then
    jq '{status, ok, service, checkedAt, worker: .worker.status, queue: .queue.status}' /tmp/swift-health.json || true
  else
    cat /tmp/swift-health.json
    printf '\n'
  fi
}

verify() {
  cd "$SWIFT_RUNTIME_DIR"
  log "running deploy readiness"
  npm run deploy:readiness

  health_check "local sandbox" "http://127.0.0.1:8080/health"
  health_check "local worker" "http://127.0.0.1:4000/health"

  if [ "$SWIFT_SKIP_PUBLIC_HEALTH" = "1" ]; then
    log "skipping public health checks"
    return
  fi

  health_check "public sandbox" "https://${SWIFT_SANDBOX_DOMAIN}/health"
  health_check "public worker" "https://${SWIFT_SANDBOX_DOMAIN}/worker/health"
}

main() {
  require_command git
  require_command npm
  require_command npx
  require_command pm2
  require_command curl

  [ -d "$SWIFT_RUNTIME_DIR/.git" ] || die "$SWIFT_RUNTIME_DIR is not a git checkout"

  check_env
  update_repo
  install_dependencies
  restart_services
  verify

  log "deploy finished"
}

main "$@"
