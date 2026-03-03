#!/usr/bin/env sh
set -eu

ok() {
  printf "[OK] %s\n" "$1"
}

warn() {
  printf "[WARN] %s\n" "$1"
}

fail() {
  printf "[ERROR] %s\n" "$1" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_DIR="$INFRA_DIR/env"

ensure_env_file() {
  rel="$1" # e.g. .env.common
  target="$ENV_DIR/$rel"
  example="$ENV_DIR/${rel}.example"

  if [ -f "$target" ]; then
    ok "env 파일 존재: infra/env/$rel"
    return 0
  fi

  if [ -f "$example" ]; then
    cp "$example" "$target"
    ok "env 파일 생성: infra/env/$rel (from ${rel}.example)"
    return 0
  fi

  # Minimal fallback (should rarely happen; examples are committed).
  case "$rel" in
    .env.common)
      cat >"$target" <<'EOF'
# auto-generated minimal defaults
APP_PROFILE=dev
POSTGRES_DB=archive
POSTGRES_USER=archive
POSTGRES_PASSWORD=archive_pw
DATABASE_URL=postgresql+psycopg://archive:archive_pw@postgres:5432/archive
REDIS_URL=redis://redis:6379/0
MINIO_ROOT_USER=minio
MINIO_ROOT_PASSWORD=minio_secret
MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=minio
MINIO_SECRET_KEY=minio_secret
STORAGE_BACKEND=minio
STORAGE_BUCKET=archive
SESSION_SECRET=change-me-session-secret-for-prod
FRONTEND_BASE_URL=http://localhost:3000
NEXT_PUBLIC_API_BASE=/api
EOF
      ;;
    *)
      cat >"$target" <<EOF
# auto-generated minimal defaults
ENV=${rel#".env."}
EOF
      ;;
  esac
  warn "env 파일이 없어 최소 기본값으로 생성했습니다: infra/env/$rel"
}

command -v docker >/dev/null 2>&1 || fail "docker 명령을 찾을 수 없습니다."
ok "docker 발견: $(docker --version)"

if docker compose version >/dev/null 2>&1; then
  ok "docker compose plugin 사용 가능"
elif command -v docker-compose >/dev/null 2>&1; then
  ok "docker-compose 사용 가능"
else
  fail "docker compose 또는 docker-compose가 필요합니다."
fi

docker info >/dev/null 2>&1 || fail "Docker daemon에 연결할 수 없습니다. Docker Desktop 실행 상태를 확인하세요."
ok "Docker daemon 연결 성공"

if docker buildx version >/dev/null 2>&1; then
  ok "docker buildx 사용 가능"
else
  warn "docker buildx 미설치 (compose 빌드 시 경고가 표시될 수 있음)"
fi

if command -v lsof >/dev/null 2>&1; then
  for port in 3000 5432 6379 7700 8000 9000 9001 9090; do
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      warn "포트 $port 이미 사용 중 (충돌 가능)"
    fi
  done
fi

mkdir -p "$ENV_DIR" || fail "env 디렉터리를 생성할 수 없습니다: $ENV_DIR"

# Compose가 요구하는 env_file이 없으면 설치 초기 단계에서 바로 실패합니다.
ensure_env_file ".env.common"
ensure_env_file ".env.dev"
ensure_env_file ".env.stage"
ensure_env_file ".env.prod"

ok "사전 점검 완료"
