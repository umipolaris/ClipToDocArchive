# OpenClaw + Telegram Document Archive

체크리스트 문서: `docs/IMPLEMENTATION_CHECKLIST.md`
이관 런북: `docs/MIGRATION_RUNBOOK.md`
릴리즈 체크리스트: `docs/RELEASE_CHECKLIST.md`

## 제품 개요
이 시스템은 Telegram/OpenClaw로 들어온 파일·메모를 자동 수집해 문서 아카이브로 운영할 수 있게 만든 플랫폼입니다.

- 수집: 파일 저장, 캡션 우선 메타 추출, 날짜/분류/태그 인덱싱
- 운영: 검토 큐, 규칙 버전 관리, 백필 재처리, 운영/감사 로그
- 활용: 웹 아카이브, 타임라인, 고급 검색, 관계형 마인드맵

## 어디에 사용할 수 있나
- 프로젝트 문서 포털: 회의록/도면/매뉴얼/공문 통합 아카이빙
- 조직 지식베이스: 채팅 기반 업로드 + 검색/타임라인 조회
- 규정/절차 이력 관리: 버전 히스토리 + 검토 상태 추적
- 운영팀 백오피스: 분류 규칙 실험/반영/백필 자동화

## 핵심 특징
- 캡션 우선 규칙 엔진: `title/description/#분류/#날짜/#태그` 우선 처리
- 비동기 파이프라인: FastAPI + Celery + Redis 상태머신 처리
- 중복 방지 저장: SHA256 기반 파일 저장 + 논리 링크
- 계층형 IA UI: Archive/Timeline/Search/Review Queue/Rules/Admin
- 아카이브 생산성 UI: 상단 1줄 `간편게시`, `상세게시` 진입, 검색/필터·보기/컬럼설정 접기/펼치기
- 게시물 코멘트 시스템: 문서별 코멘트 작성/수정/삭제, 작성자 본인 또는 ADMIN만 수정/삭제
- 리스트 가시성 강화: 아카이브 목록 제목 옆 코멘트 아이콘+개수 배지 표시
- 운영자 중심 규칙 관리: UI 편집 + JSON import/export + backfill
- 대용량 대비: Postgres 인덱스/페이지네이션/가상화 리스트
- 검색 확장: Postgres FTS 기본 + Meilisearch 옵션
- 관측성: 구조화 로그, Prometheus 메트릭, 기본 알림 규칙

## 장점
- 채팅 기반 업로드를 운영 가능한 문서 시스템으로 즉시 전환 가능
- 규칙 변경과 재처리를 운영자가 직접 수행 가능
- ingest 실패/검토 필요 건을 분리해 운영 리스크를 낮춤
- Docker Compose로 개발/운영 환경 재현성이 높음

## 한계 및 주의사항
- OCR/고급 내용 추출은 기본 범위가 아니며 파일 유형별 제약이 있음
- Meilisearch 미사용 시 복합 검색 성능은 DB 의존적
- Telegram/OpenClaw 연동 품질은 외부 시스템 상태에 영향받음
- 프로덕션 배포 전에는 비밀번호/비밀키/도메인 값을 반드시 교체해야 함

## 스크린샷
개인정보 보호를 위해 스크린샷 PNG는 기본적으로 저장소에 커밋하지 않습니다.

스크린샷 생성(로컬 전용):
```bash
./scripts/capture_screenshots.sh
```

생성 위치:
- `docs/screenshots/login.png`
- `docs/screenshots/archive.png`
- `docs/screenshots/timeline.png`
- `docs/screenshots/search.png`
- `docs/screenshots/rules.png`
- `docs/screenshots/mind-map.png`

## 시스템 요구사항
| 구분 | 최소 | 권장 |
| --- | --- | --- |
| OS | macOS/Linux/Windows(WSL2) | Linux 서버 또는 macOS |
| CPU | 4 vCPU | 8 vCPU+ |
| 메모리 | 8GB | 16GB+ |
| 디스크 | 20GB SSD | 50GB+ SSD |
| 네트워크 | 인터넷(이미지/패키지 pull) | 고정 대역폭 |

## 필수 소프트웨어
- Docker Engine 또는 Docker Desktop
- Docker Compose(`docker compose` 또는 `docker-compose`)
- `curl`
- 선택: `make`(없으면 `./scripts/quickstart.sh`)

## 기술 스택 및 핵심 라이브러리
| 레이어 | 스택/라이브러리 |
| --- | --- |
| Backend | FastAPI, SQLAlchemy, Alembic, Pydantic, Uvicorn |
| Worker | Celery, Redis |
| Storage/DB | PostgreSQL 15+, MinIO(S3 호환) |
| Search | PostgreSQL FTS, Meilisearch(옵션) |
| Frontend | Next.js 14, TypeScript, Tailwind CSS, shadcn/ui 기반 컴포넌트 |
| Observability | structlog(JSON), prometheus-client, Prometheus |
| Infra/CI | Docker Compose, GitHub Actions |

## 개인정보 업로드 차단 가드
- 로컬 훅: `.githooks/pre-commit`, `.githooks/pre-push`
- 검사 스크립트: `scripts/check_sensitive_guard.sh`
- CI 검사: `.github/workflows/privacy-guard.yml`

설치/실행:
```bash
git config core.hooksPath .githooks
scripts/check_sensitive_guard.sh --staged
scripts/check_sensitive_guard.sh --all
```

## 로그인 보안 설정
- 비밀번호 정책: 관리자 UI에서 최소 길이/문자 조건(대문자/소문자/숫자/특수문자) 편집 가능
- 로그인 실패 잠금: 관리자 UI에서 허용 횟수/잠금 시간(초) 편집 가능
- 관리자 UI:
  - 사용자 생성 시 비밀번호 2회 입력 확인
  - 사용자 비밀번호 재설정 시 비밀번호 2회 입력 확인
  - 잠금 계정은 `잠금 해제` 버튼으로 즉시 해제 가능
  - `Admin > 사용자 관리 > 로그인 보안 정책`에서 저장 시 즉시 반영

환경변수:
- `PASSWORD_MIN_LENGTH` (기본 `10`)
- `AUTH_MAX_FAILED_ATTEMPTS` (기본 `5`)
- `AUTH_LOCKOUT_SECONDS` (기본 `900`)
- `SESSION_HTTPS_ONLY` (운영 HTTPS 환경에서 `true` 권장)
- `SESSION_SAME_SITE` (기본 `lax`)

## 관리자/권한 표
이 시스템은 `ADMIN` 계정을 여러 개 둘 수 있습니다.  
각 관리자의 수행 작업은 감사 로그에 `actor_user_id`/`actor_username`으로 남습니다.

### 역할별 권한 매트릭스
| 역할 | 문서 조회 | 문서 편집/삭제 | 검토 큐 처리 | Rules 변경/백필 | Admin 메뉴 |
| --- | --- | --- | --- | --- | --- |
| `VIEWER` | O | X | X | X | X |
| `REVIEWER` | O | X | O | 조회/시뮬레이션만 O | X |
| `EDITOR` | O | O | O | X | X |
| `ADMIN` | O | O | O | O | O |

### 관리자 기능(복수 관리자 공통)
| 기능 | 설명 | UI 위치 | 주요 API |
| --- | --- | --- | --- |
| 사용자 관리 | 사용자 생성/권한변경/활성화/비밀번호 재설정 | `Admin > 사용자 관리` | `GET/POST/PATCH /api/admin/users` |
| 로그인 보안 정책 | 비밀번호 정책/잠금 정책 편집 | `Admin > 사용자 관리` | `GET/PATCH /api/admin/security-policy` |
| 감사 로그 조회 | 누가/언제/무엇 변경했는지 조회 | `Admin > 운영/감사 로그` | `GET /api/admin/audit-logs` |
| 감사 로그 내보내기 | csv/json 포맷 export | `Admin > 운영/감사 로그` | `GET /api/admin/audit-logs/export` |
| ingest 작업 추적 | 실패/재시도 대상 작업 및 이벤트 조회 | `Admin > 운영/감사 로그` | `GET /api/admin/ingest-jobs`, `GET /api/admin/ingest-jobs/{job_id}/events` |
| ingest 수동 재처리 | 재큐잉/파일 복구 업로드 | `Admin > 운영/감사 로그` | `POST /api/admin/ingest-jobs/{job_id}/requeue`, `POST /api/admin/ingest-jobs/{job_id}/recover-upload` |
| 백업/복구 | DB/첨부/설정 백업 생성, 다운로드/삭제, 복구 실행 | `Admin > 백업/복구` | `GET /api/admin/backups/files`, `POST /api/admin/backups/run/{kind}`, `POST /api/admin/backups/restore/*`, `DELETE /api/admin/backups/files/{kind}/{filename}` |
| 운영 리포트 | 주간 운영지표 생성/조회 | `Admin > 운영/감사 로그` | `POST /api/admin/ops-reports/generate`, `GET /api/admin/ops-reports` |

### 추가 관리자 계정 생성 예시
```bash
curl -X POST http://localhost:8000/api/admin/users \
  -b /tmp/archive.cookie \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin_ops_01","password":"TempPass123!","role":"ADMIN"}'
```

## 실행 전 요구사항
- Docker Engine 또는 Docker Desktop (daemon 실행 상태)
- Docker Compose (`docker compose` 또는 `docker-compose`)
- `curl`
- 선택: `make` (없어도 `./scripts/quickstart.sh` 사용 가능)

## 설치 가이드 (초보자)
이 프로젝트는 Docker로 실행되며, Python/Node/PostgreSQL/Redis/MinIO를 로컬에 따로 설치할 필요가 없습니다.

### 0) 준비물 체크
- Git(권장) 또는 ZIP 다운로드
- Docker Desktop(Windows/macOS) 또는 Docker Engine(Linux)
- Docker Compose
- Windows는 WSL2 환경에서 실행하는 것을 권장합니다(권한/성능/경로 이슈 최소화).

### 1) 프로젝트 받기
아래 중 한 가지로 받으면 됩니다.

1) Git으로 받기(권장)
```bash
git clone https://github.com/umipolaris/openclaw-telegram-archive.git
cd openclaw-telegram-archive
```

2) ZIP으로 받기
- GitHub에서 `Code > Download ZIP`으로 다운로드 후 압축 해제
- 압축 해제한 폴더 안에 `backend/`, `frontend/`, `infra/` 폴더가 보이면 정상입니다.

### 1-1) (Ubuntu) Docker 설치(처음 1회)
Ubuntu 리눅스에서 바로 실행하려면 Docker Engine과 Compose가 필요합니다.

1) Ubuntu가 “리눅스 PC/서버(네이티브)”인 경우
```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

권한 설정(권장, sudo 없이 docker 실행):
```bash
sudo usermod -aG docker $USER
newgrp docker
```

정상 동작 확인:
```bash
docker version
docker compose version
docker run --rm hello-world
```

2) Ubuntu가 “Windows의 WSL2(Ubuntu)”인 경우
- 권장 방식: Windows에 Docker Desktop 설치 후, Docker Desktop 설정에서 `WSL integration`을 켭니다.
- 이 경우 WSL2 내부에 Docker Engine을 따로 설치하지 않고도 `docker`/`docker compose`가 동작합니다.

### 2) Docker가 정상인지 확인
Docker가 실행 중인지 확인합니다.

```bash
docker version
docker compose version
```

만약 `docker compose`가 없다면(구형 환경):
```bash
docker-compose version
```

### 3) 실행(개발 프로필: dev)
아래 둘 중 편한 방법을 선택하세요.

1) `make`가 있는 경우(가장 간단)
```bash
make first-run
```

2) `make`가 없는 경우(직접 compose 실행)
```bash
./infra/scripts/doctor.sh
cd infra
docker compose up -d --build
```

Windows PowerShell에서 `./scripts/*.sh`가 안 돌아가면:
- WSL2(Ubuntu) 터미널에서 위 명령을 실행하거나,
- PowerShell에서 `docker compose ...`만 사용하세요.

### 4) 초기 관리자 계정 생성(최초 1회)
기본 계정 예시(`admin` / `ChangeMe123!`)로 생성합니다.

1) `make` 사용
```bash
make bootstrap-admin ADMIN_USER=admin ADMIN_PASS='ChangeMe123!'
```

2) `docker compose` 직접 실행(Windows PowerShell 포함)
```bash
cd infra
docker compose exec -T api python scripts/bootstrap_admin.py --username admin --password "ChangeMe123!"
```

### 5) 접속 확인
- 프론트: `http://localhost:3000/archive`
- API 헬스: `http://localhost:8000/api/health`
- MinIO Console: `http://localhost:9001`
- Prometheus: `http://localhost:9090`

### 6) 종료/재시작
```bash
# 로그 보기
cd infra
docker compose logs -f --tail=200

# 종료(데이터 유지)
docker compose down

# 재시작
docker compose up -d --build
```

### 7) 완전 초기화(선택)
모든 데이터를 지우고 처음부터 시작하려면:
1) 스택 종료: `cd infra && docker compose down`
2) 데이터 삭제: `infra/data/*` 폴더 삭제

### 8) 자주 겪는 문제(FAQ)
1) `unknown shorthand flag: 'd' in -d` 또는 `compose` 관련 오류
- `docker compose version`이 정상 출력되는지 확인하세요.
- Docker Desktop이 실행 중인지 확인하세요(Windows/macOS).

2) 페이지가 안 뜨는 경우
- `cd infra && docker compose ps`로 컨테이너가 `Up`인지 확인
- `docker compose logs -f api` / `docker compose logs -f frontend`로 에러 확인

3) 포트 충돌(이미 다른 프로그램이 쓰는 경우)
- 기본 포트: `3000(프론트)`, `8000(API)`, `5432(Postgres)`, `9000/9001(MinIO)`, `6379(Redis)`, `7700(Meili)`, `9090(Prometheus)`
- 이미 사용 중이면 해당 프로그램을 종료하거나 compose 포트를 변경해야 합니다.

## 빠른 시작(요약)
아래 순서만 실행하면 됩니다.

```bash
# 1) 사전 점검 + 전체 스택 실행 + API 헬스체크 대기
make first-run

# 2) 초기 관리자 생성 (최초 1회)
make bootstrap-admin ADMIN_USER=admin ADMIN_PASS='ChangeMe123!'
```

또는 단일 스크립트:

```bash
./scripts/quickstart.sh
make bootstrap-admin ADMIN_USER=admin ADMIN_PASS='ChangeMe123!'
```

접속 URL:
- 프론트: `http://localhost:3000/archive`
- API: `http://localhost:8000/api/health`
- MinIO Console: `http://localhost:9001`
- Prometheus: `http://localhost:9090`

정지/로그:

```bash
make logs
make down
```

참고:
- `make`가 없으면 `cd infra && ./scripts/compose.sh up -d --build`로 동일 실행 가능합니다.
- `./scripts/compose.sh`는 `docker compose`와 `docker-compose`를 자동 감지합니다.

## macOS 재부팅 자동 시작
맥 재부팅(로그인) 후 서비스가 자동 기동되도록 `launchd` 에이전트를 설치할 수 있습니다.

```bash
cd infra
chmod +x scripts/autostart-up.sh scripts/install-autostart-macos.sh scripts/uninstall-autostart-macos.sh
./scripts/install-autostart-macos.sh
```

기본 동작:
- Docker daemon 준비 대기 후 `docker compose up -d` 자동 실행
- 프로필 기본값: `APP_PROFILE=dev`
- 빌드 없이 기동(필요 시 `AUTO_START_BUILD=true`로 설치)
- 실패 시 자동 재시도(launchd + 스크립트 내부 retry)

옵션 예시(설치 시 함께 전달 가능):
```bash
cd infra
APP_PROFILE=dev AUTO_START_BUILD=false AUTO_START_MAX_RETRIES=10 AUTO_START_RETRY_INTERVAL=30 ./scripts/install-autostart-macos.sh
```

상태 확인:
```bash
launchctl print gui/$(id -u)/com.umipolaris.docarchive.autostart
tail -f infra/data/logs/com.umipolaris.docarchive.autostart.out.log
tail -f infra/data/logs/com.umipolaris.docarchive.autostart.err.log
```

해제:
```bash
cd infra
./scripts/uninstall-autostart-macos.sh
```

## 아카이브 UI 사용 요약 (현재)
- 페이지 최상단 우측: 한 줄형 `간편게시` 입력(`파일 1개 + 설명 + 간편게시`), 등록 즉시 목록 갱신
- 게시물 목록 카드 상단: 슬림 툴바
  - `검색/필터` 버튼: 검색어/검토상태/정렬 조건 패널 토글
  - `보기/컬럼설정` 버튼: 컴팩트 보기, 컬럼 표시/순서, 프리셋 패널 토글
  - `상세게시` 버튼: `/manual-post` 상세 입력 화면 이동
- 목록 행 클릭: 우측 패널이 아닌 `문서 상세 팝업(모달)` 오픈
- 문서 상세 팝업(`메타 > 보기`): 하단 1줄 코멘트 입력 + 우측 작은 `등록` 버튼
- 문서 상세/아카이브 상세: 코멘트 목록 조회, 코멘트 수정/삭제(권한 규칙 적용)
- 아카이브 리스트 제목 셀: 코멘트가 있으면 `말풍선 아이콘 + 개수` 자동 표시

## 최근 반영 사항 (2026-02-27)
- 간편게시 단일 라인 설명 입력 시 요약 텍스트가 2번 중복되던 문제 수정
- 코멘트 API 추가:
  - `GET /api/documents/{id}/comments`
  - `POST /api/documents/{id}/comments`
  - `PATCH /api/documents/{id}/comments/{comment_id}`
  - `DELETE /api/documents/{id}/comments/{comment_id}`
- 문서 목록 API(`GET /api/documents`)에 `comment_count` 필드 추가

## 로컬 데이터 저장 위치
Docker Compose는 운영 데이터(파일/DB/캐시/검색인덱스)를 `infra/data` 아래에 저장합니다.

- PostgreSQL: `infra/data/postgres`
- MinIO object 파일: `infra/data/minio`
- Redis: `infra/data/redis`
- Meilisearch index: `infra/data/meili`
- ingest 임시파일: `infra/data/ingest_tmp`
- 백업 파일(DB): `infra/data/backup/db`
- 백업 파일(첨부): `infra/data/backup/objects`
- 백업 파일(설정): `infra/data/backup/config`

## 백업/복구 운영 (웹 + CLI)
웹(Admin) 기준:
- `Admin > 백업/복구` 탭에서 `DB/첨부파일/설정` 백업 실행
- 백업 파일 목록에서 다운로드/삭제 가능
- 복구는 DB/첨부/설정 각각 별도 실행
  - 설정은 `preview/apply` 모드 지원

CLI 기준:
```bash
# 백업
make backup-db
make backup-objects
make backup-config
make backup-all

# 복구 (확인 플래그 필요)
make restore-db BACKUP_FILE=./infra/data/backup/db/archive_archive_YYYYMMDD_HHMMSS.dump CONFIRM=YES
make restore-objects BACKUP_FILE=./infra/data/backup/objects/objects_snapshot_minio_YYYYMMDD_HHMMSS.tar.gz CONFIRM=YES
make restore-config BACKUP_FILE=./infra/data/backup/config/config_YYYYMMDD_HHMMSS.tar.gz MODE=preview
```

주의:
- Admin 웹 복구(`/api/admin/backups/restore/objects`)는 API가 생성한 첨부 백업(`kind=objects`)만 지원합니다.
- `make backup-objects`로 생성되는 `objects_snapshot_*` 파일은 CLI 복구(`make restore-objects`) 전용입니다.

백업 API 예시(Admin 세션 필요):
```bash
# 1) 백업 파일 목록
curl -b /tmp/archive.cookie "http://localhost:8000/api/admin/backups/files?kind=db"

# 2) 백업 생성
curl -X POST -b /tmp/archive.cookie "http://localhost:8000/api/admin/backups/run/db"
curl -X POST -b /tmp/archive.cookie "http://localhost:8000/api/admin/backups/run-all"

# 3) 백업 다운로드
curl -L -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/backups/files/db/<FILENAME>/download" \
  -o ./db-backup.dump

# 4) 백업 삭제
curl -X DELETE -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/backups/files/db/<FILENAME>"

# 5) DB 복구
curl -X POST -b /tmp/archive.cookie \
  -H 'Content-Type: application/json' \
  -d '{"filename":"<FILENAME>","target_db":"archive_restore","confirm":true}' \
  "http://localhost:8000/api/admin/backups/restore/db"
```

## 읽기 전용 모드 (cut-over/점검용)
`READ_ONLY_MODE=true`이면 API 쓰기 요청(`POST/PUT/PATCH/DELETE`)을 차단합니다.
허용 예외: 로그인/로그아웃, 조회성 `GET/HEAD/OPTIONS`.

```bash
# infra/env/.env.common 또는 .env.dev
READ_ONLY_MODE=true

cd infra
./scripts/compose.sh up -d --build api
```

## 데이터 정합성 검사 (이관/운영 점검)
`validate_integrity.py`는 아래 항목을 자동 점검하고 텍스트/JSON 리포트를 생성합니다.

- 참조 무결성(문서-카테고리, document_files/document_tags/document_versions, ingest jobs/events)
- 문서 버전 일관성(`current_version_no` vs `document_versions` 최대 버전)
- `files.checksum_sha256` 형식
- telegram `source_ref` 중복
- 저장소 실물 파일 존재 여부(disk/minio, 옵션)

권장 실행(컨테이너 내부):

```bash
cd infra
./scripts/compose.sh exec -T api sh -lc '
  cd /app &&
  PYTHONPATH=/app python scripts/validate_integrity.py \
    --report /tmp/integrity_report.txt \
    --json-report /tmp/integrity_report.json \
    --check-storage auto \
    --storage-probe-limit 2000 \
    --max-samples 20
'
```

주요 옵션:
- `--check-storage {auto|none|disk|minio}`
- `--storage-probe-limit <N>`
- `--max-samples <N>`
- `--fail-on-error` (ERROR 발견 시 종료코드 2)

## 레거시 `index.json` 이관
`import_index_json.py`는 기존 JSON 인덱스를 신규 스키마(`documents/files/document_versions/...`)로 적재합니다.

주요 동작:
- `source+source_ref` 기준 기존 문서는 중복 생성하지 않고 skip
- 파일은 `sha256` 기준 dedupe 후 현재 저장 백엔드(minio/disk)에 재저장
- 캡션/규칙 엔진을 적용해 제목/설명/날짜/태그/분류를 생성
- 텍스트/JSON 리포트 생성 가능

권장 실행(먼저 dry-run):

```bash
cd infra
./scripts/compose.sh exec -T api sh -lc '
  cd /app &&
  PYTHONPATH=/app python scripts/import_index_json.py \
    --index-json /app/tmp/legacy_import_sample/index.json \
    --legacy-root /app/tmp/legacy_import_sample \
    --dry-run \
    --report /tmp/import_report.txt \
    --json-report /tmp/import_report.json
'
```

실제 반영 실행:

```bash
cd infra
./scripts/compose.sh exec -T api sh -lc '
  cd /app &&
  PYTHONPATH=/app python scripts/import_index_json.py \
    --index-json /app/tmp/legacy_import_sample/index.json \
    --legacy-root /app/tmp/legacy_import_sample \
    --missing-file skip \
    --report /tmp/import_report.txt \
    --json-report /tmp/import_report.json
'
```

옵션:
- `--source-mode {auto|telegram|wiki|manual|api}`: 레거시 source 해석 방식
- `--source-ref-prefix <prefix>`: source_ref가 비어있는 행의 기본 prefix
- `--missing-file {skip|fail|document-only}`: 원본 파일 누락 처리 정책
- `--created-by-username <username>`: 생성자 사용자 지정
- `--stop-on-error`: 첫 오류에서 즉시 중단

## 검토 큐 자동 정리 (중복 의심 사유)
`DUPLICATE_SUSPECT`처럼 반복되는 검토 사유는 운영 스크립트로 일괄 해소할 수 있습니다.

```bash
cd infra

# 미리보기(반영 없음)
./scripts/compose.sh exec -T api sh -lc '
  cd /app &&
  PYTHONPATH=/app python scripts/review_queue_auto_resolve.py \
    --reason DUPLICATE_SUSPECT \
    --dry-run
'

# 실제 반영
./scripts/compose.sh exec -T api sh -lc '
  cd /app &&
  PYTHONPATH=/app python scripts/review_queue_auto_resolve.py \
    --reason DUPLICATE_SUSPECT
'

# 혼합 사유 문서에서도 해당 사유만 제거(예: CLASSIFY_FAIL+DATE_MISSING+DUPLICATE_SUSPECT)
./scripts/compose.sh exec -T api sh -lc '
  cd /app &&
  PYTHONPATH=/app python scripts/review_queue_auto_resolve.py \
    --reason DUPLICATE_SUSPECT \
    --include-mixed-reasons
'
```

## UAT 스모크 점검
로그인/목록/상세/다운로드/검토큐/대시보드를 한 번에 점검합니다.

```bash
cd infra
./scripts/compose.sh exec -T api sh -lc '
  cd /app &&
  PYTHONPATH=/app python scripts/smoke_uat.py \
    --api http://localhost:8000/api \
    --username admin \
    --password "UatPass123!" \
    --include-download
'
```

## Meilisearch 옵션 검색 활성화
기본값은 `SEARCH_BACKEND=postgres`입니다. Meilisearch를 쓰려면 아래처럼 변경 후 재기동하세요.

```bash
# infra/env/.env.common 또는 .env.dev
SEARCH_BACKEND=meili
SEARCH_AUTO_SYNC=true
MEILI_URL=http://meilisearch:7700
MEILI_API_KEY=
MEILI_INDEX_DOCUMENTS=documents
```

```bash
cd infra
./scripts/compose.sh up -d --build
```

최초 활성화 시 기존 문서를 한번 재인덱싱하는 것을 권장합니다.

```bash
cd backend
python scripts/reindex_search.py --batch-size 500
```

## 인증 시작 (필수)
보호된 API(`/api/documents`, `/api/review-queue`, `/api/rules*`, `/api/ingest*`)는 로그인 세션이 필요합니다.

```bash
# 1) 초기 관리자 계정 생성 (최초 1회)
cd backend
python scripts/bootstrap_admin.py --username admin --password 'ChangeMe123!'

# 2) 로그인 + 세션 쿠키 저장
curl -i -c /tmp/archive.cookie \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe123!"}' \
  http://localhost:8000/api/auth/login

# 2-1) 본인 비밀번호 변경(현재 비밀번호 확인 + 새 비밀번호 2회 입력)
curl -X POST http://localhost:8000/api/auth/change-password \
  -b /tmp/archive.cookie \
  -H 'Content-Type: application/json' \
  -d '{
    "current_password":"ChangeMe123!",
    "new_password":"StrongPass123!",
    "confirm_new_password":"StrongPass123!"
  }'

# 3) 보호 API 호출 (쿠키 사용)
curl -b /tmp/archive.cookie "http://localhost:8000/api/review-queue?page=1&size=20"

# 3-1) 문서 목록 조회(서버사이드 정렬/필터)
curl -b /tmp/archive.cookie \
  "http://localhost:8000/api/documents?page=1&size=20&q=테스트&category_name=회의&sort_by=event_date&sort_order=desc"

# 4) 대시보드 집계 조회
curl -b /tmp/archive.cookie "http://localhost:8000/api/dashboard/summary?recent_limit=8"

# 5) 아카이브 트리 조회 (카테고리/연/월)
curl -b /tmp/archive.cookie "http://localhost:8000/api/archive/tree"

# 5-1) 아카이브 세트/개정 집계 조회
curl -b /tmp/archive.cookie \
  "http://localhost:8000/api/archive/sets?page=1&size=10&include_unmapped=true"

# 6) 관리자 사용자 목록 조회
curl -b /tmp/archive.cookie "http://localhost:8000/api/admin/users"

# (옵션) 사용자 목록 검색/필터/페이지네이션
curl -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/users?page=1&size=20&q=viewer&role=REVIEWER&is_active=true"

# 7) 사용자 역할 변경/활성화 토글
curl -X PATCH http://localhost:8000/api/admin/users/<USER_ID> \
  -b /tmp/archive.cookie \
  -H 'Content-Type: application/json' \
  -d '{"role":"REVIEWER","is_active":true}'

# 8) 사용자 비밀번호 재설정
curl -X PATCH http://localhost:8000/api/admin/users/<USER_ID> \
  -b /tmp/archive.cookie \
  -H 'Content-Type: application/json' \
  -d '{"password":"TempPass123!","password_confirm":"TempPass123!"}'

# 8-1) 사용자 계정 삭제
curl -X DELETE http://localhost:8000/api/admin/users/<USER_ID> \
  -b /tmp/archive.cookie

# 8-2) 로그인 보안 정책 조회/변경
curl -b /tmp/archive.cookie "http://localhost:8000/api/admin/security-policy"

curl -X PATCH http://localhost:8000/api/admin/security-policy \
  -b /tmp/archive.cookie \
  -H 'Content-Type: application/json' \
  -d '{
    "password_min_length": 12,
    "require_uppercase": true,
    "require_lowercase": true,
    "require_digit": true,
    "require_special": false,
    "max_failed_attempts": 5,
    "lockout_seconds": 1800
  }'

# 9) 저장 필터 생성/조회/삭제
curl -X POST http://localhost:8000/api/saved-filters \
  -b /tmp/archive.cookie \
  -H 'Content-Type: application/json' \
  -d '{"name":"검토큐","filter_json":{"review_status":"NEEDS_REVIEW"},"is_shared":false}'

curl -b /tmp/archive.cookie "http://localhost:8000/api/saved-filters?page=1&size=20&include_shared=true"

curl -X DELETE http://localhost:8000/api/saved-filters/<FILTER_ID> \
  -b /tmp/archive.cookie

# 10) 감사 로그 조회 (ADMIN)
curl -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/audit-logs?page=1&size=20&action=AUTH&include_payload=false"

# 10-1) 감사 로그 고급 검색 + export
curl -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/audit-logs?page=1&size=20&q=DOCUMENT&target_type=document&source_ref=msg:"

curl -L -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/audit-logs/export?fmt=csv&include_payload=false&limit=5000" \
  -o ./audit_logs.csv

# 11) 운영 로그(ingest jobs/events) 조회 (ADMIN)
curl -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/ingest-jobs?page=1&size=20&state=FAILED"

curl -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/ingest-jobs/<JOB_ID>/events?limit=100"

# 12) ingest job 재처리 큐잉 (ADMIN)
curl -X POST http://localhost:8000/api/admin/ingest-jobs/<JOB_ID>/requeue \
  -b /tmp/archive.cookie \
  -H 'Content-Type: application/json' \
  -d '{"force":false,"reset_attempts":false,"clear_error":true}'

# 13) 실패 job 파일 업로드 복구 + 재처리 (ADMIN)
curl -X POST http://localhost:8000/api/admin/ingest-jobs/<JOB_ID>/recover-upload \
  -b /tmp/archive.cookie \
  -F "file=@./sample.pdf" \
  -F "caption=복구 업로드 캡션\n#분류:회의\n#날짜:2026-02-24" \
  -F "reset_attempts=true" \
  -F "clear_error=true"

# 14) 운영 리포트 생성/조회 (ADMIN)
curl -X POST -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/ops-reports/generate?days=7"

curl -b /tmp/archive.cookie \
  "http://localhost:8000/api/admin/ops-reports?page=1&size=20"
```

## OpenClaw 연동 브리지(텔레그램 파일 즉시 업로드)
```bash
cd backend

# 환경변수(최초 1회)
export ARCHIVE_API=http://localhost:8000/api
export ARCHIVE_USERNAME=admin
export ARCHIVE_PASSWORD='ChangeMe123!'

# OpenClaw가 받은 파일 경로 + 캡션 + message/chat id로 업로드
python scripts/openclaw_ingest_bridge.py \
  --file /absolute/path/from/openclaw.xlsx \
  --caption "샘플 점검 문서 요약본" \
  --message-id 663 \
  --chat-id telegram:1000000000
```

`source_ref`는 기본적으로 `msg:<message-id>`가 자동 생성됩니다.

## CLI 수집 예시
```bash
cd backend

# 단일 업로드
python scripts/ingest_cli.py \
  --api http://localhost:8000/api \
  --file ./sample.pdf \
  --caption "주간 운영회의\n진행상황\n#분류:회의\n#날짜:2026-02-24\n#태그:alpha,beta" \
  --source telegram \
  --msg-id 12345 \
  --chat-id -100000000

# 다중 업로드(배치): --file 반복
python scripts/ingest_cli.py \
  --api http://localhost:8000/api \
  --file ./docs/a.pdf \
  --file ./docs/b.pdf \
  --file ./docs/c.pdf \
  --caption "DCP 배치 등록\n#분류:DCP\n#날짜:2026-02-24" \
  --source telegram \
  --msg-id 12346 \
  --chat-id -100000000 \
  --source-ref-prefix msg:12346
```

## 배치 업로드 API
```bash
# Telegram batch
curl -X POST http://localhost:8000/api/ingest/telegram/batch \
  -b /tmp/archive.cookie \
  -F "source=telegram" \
  -F "source_ref_prefix=msg:90001" \
  -F "message_id=90001" \
  -F "chat_id=-100000000" \
  -F "caption=배치 업로드\n#분류:회의" \
  -F "files=@./a.pdf" \
  -F "files=@./b.pdf"

# Manual/API batch
curl -X POST http://localhost:8000/api/ingest/manual/batch \
  -b /tmp/archive.cookie \
  -F "source=manual" \
  -F "source_ref_prefix=manual:2026-02-24" \
  -F "caption=일괄 등록" \
  -F "title=일괄 등록 문서" \
  -F "description=같은 설명을 여러 파일에 적용" \
  -F "files=@./1.pdf" \
  -F "files=@./2.pdf"
```

## 수동 게시글 생성 (파일 없이 등록)
```bash
curl -X POST http://localhost:8000/api/documents/manual-post \
  -b /tmp/archive.cookie \
  -H "Content-Type: application/json" \
  -d '{
    "source": "manual",
    "source_ref": "manual:2026-02-24:notice-001",
    "title": "문서 포털 운영 공지",
    "description": "이번 주 점검 일정 공지",
    "category_name": "공지",
    "event_date": "2026-02-24",
    "tags": ["set:ops-notice", "dockey:portal-maintenance-notice", "rev:1", "kind:notice", "lang:ko"],
    "review_status": "NONE"
  }'
```

- `Manual Post` 화면은 기본적으로 템플릿 고정 모드로 동작하며 캡션을 아래 구조로 생성합니다.
```text
1행: 제목
2행: 설명
#분류:<카테고리>
#날짜:<YYYY-MM-DD>
#태그:set:<...>,dockey:<...>,rev:<...>,kind:<...>,lang:<...>
```

## 업로드 파일 교체/삭제 API
```bash
# 0) 게시물(문서) 메타 편집
curl -X PATCH http://localhost:8000/api/documents/<DOC_ID> \
  -b /tmp/archive.cookie \
  -H "Content-Type: application/json" \
  -d '{
    "title":"수정된 제목",
    "description":"수정된 설명",
    "category_name":"공지",
    "event_date":"2026-02-24",
    "tags":["공지","운영"],
    "review_status":"NONE"
  }'

# 0-1) 게시물(문서) 삭제
curl -X DELETE http://localhost:8000/api/documents/<DOC_ID> \
  -b /tmp/archive.cookie

# 1) 문서 파일 교체
curl -X POST http://localhost:8000/api/documents/<DOC_ID>/files/<FILE_ID>/replace \
  -b /tmp/archive.cookie \
  -F "file=@./replacement.pdf" \
  -F "change_reason=manual_file_replace"

# 2) 문서 파일 삭제
curl -X DELETE http://localhost:8000/api/documents/<DOC_ID>/files/<FILE_ID> \
  -b /tmp/archive.cookie

# 3) 파일 다운로드(링크 열기)
curl -L http://localhost:8000/api/files/<FILE_ID>/download \
  -b /tmp/archive.cookie \
  -o ./downloaded.bin

# 4) 버전 diff 조회
curl -b /tmp/archive.cookie \
  "http://localhost:8000/api/documents/<DOC_ID>/versions/diff?from_version_no=1&to_version_no=3"
```

Archive 화면 목록/상세에서 파일명을 클릭하면 다운로드(또는 브라우저 미리보기)할 수 있고, `문서 상세 팝업(모달)`에서 게시물 편집/삭제, 파일 교체/삭제도 수행할 수 있습니다.

## 상태 머신
`RECEIVED -> STORED -> EXTRACTED -> CLASSIFIED -> INDEXED -> PUBLISHED`

검토 필요 시 `NEEDS_REVIEW`, 오류 시 `FAILED`.

재시도 중인 job은 `FAILED -> RECEIVED(RETRY_SCHEDULED)`로 전이되며 `retry_after`가 설정됩니다.  
`attempt_count >= max_attempts` 도달 시 `DEAD_LETTER` 이벤트를 기록하고 `last_error_code=DLQ_MAX_ATTEMPTS`로 종료합니다.

Meilisearch 활성화 시 문서 생성/수정/삭제, Review Queue 변경, Rules Backfill 변경 결과가 `search` 큐 워커를 통해 인덱스에 비동기 반영됩니다.

## 구조 태그 자동 보강
- 룰엔진은 문서 제목/설명/파일명에서 `set:*`, `dockey:*`, `rev:*`, `kind:*`, `lang:*` 태그를 자동 추론합니다.
- 이미 캡션 `#태그`에 구조 태그가 있으면 운영자 입력값을 우선 유지합니다.
- 수동 업로드에서 `\\n` 형태 캡션이 들어오면 제목/설명 파싱 시 개행으로 정규화합니다.

## Rules 고급 기능
- `POST /api/rules/simulate/batch`: 선택 rule version으로 기존 문서 배치 시뮬레이션(변경 건수/샘플 비교)
- `GET /api/rules/conflicts/{rule_version_id}`: 키워드 충돌 규칙 탐지
- Rules 화면에서 충돌 탐지/배치 시뮬레이션 UI를 제공합니다.

## 주간 운영 리포트 자동 생성
- Celery beat가 매주 월요일 00:15(UTC)에 `OPS_REPORT_WEEKLY` 리포트를 자동 생성합니다.
- worker는 `reports` 큐를 같이 실행합니다: `-Q ingest,backfill,search,reports`
- 수동 생성 스크립트:
```bash
cd backend
python scripts/generate_ops_report.py --days 7
```

## 재시도 백오프 설정
- `INGEST_RETRY_BASE_SECONDS` (기본 `30`)
- `INGEST_RETRY_MAX_SECONDS` (기본 `1800`)
- `.env.common`에서 조정할 수 있습니다.

## 장애코드 표준화
- ingest 실패는 단계별 코드로 기록됩니다: `STORAGE_TEMP_FILE_MISSING`, `STORAGE_WRITE_FAIL`, `CAPTION_PARSE_FAIL`, `RULE_CLASSIFY_FAIL`, `DB_WRITE_FAIL`, `NOTIFY_CALLBACK_FAIL`, `PIPELINE_UNEXPECTED`.
- Dashboard는 실패 작업의 `error_code` 분포와 `DLQ` 건수를 함께 표시합니다.

## OpenClaw 콜백 액션 규약 (재시도/재처리 버튼)
- 콜백 payload(`POST OPENCLAW_CALLBACK_URL`)에 `actions[]`를 포함합니다.
- 각 action은 `url/method/token/expires_at`를 가지며, OpenClaw는 Telegram 버튼 클릭 시 해당 URL로 호출합니다.
- 액션 토큰은 HMAC(`OPENCLAW_ACTION_SECRET`) 기반이며 TTL(`OPENCLAW_ACTION_TTL_SECONDS`)이 지나면 만료됩니다.

```json
{
  "job_id": "3f55d87f-63c8-4bc0-b472-8ee7a4f1f1ca",
  "state": "FAILED",
  "success": false,
  "error_code": "STORAGE_TEMP_FILE_MISSING",
  "actions": [
    {
      "kind": "button",
      "action": "retry",
      "label": "재시도",
      "method": "POST",
      "url": "http://localhost:8000/api/ingest/actions/<JOB_ID>/retry",
      "token": "<signed-token>",
      "expires_at": "2026-02-25T12:00:00+00:00",
      "payload": {"clear_error": true}
    },
    {
      "kind": "button",
      "action": "reprocess",
      "label": "재처리",
      "method": "POST",
      "url": "http://localhost:8000/api/ingest/actions/<JOB_ID>/reprocess",
      "token": "<signed-token>",
      "expires_at": "2026-02-25T12:00:00+00:00",
      "payload": {"reset_attempts": true, "clear_error": true}
    },
    {
      "kind": "command",
      "action": "recover_upload",
      "label": "파일 재업로드",
      "command": "/recover_upload <JOB_ID>",
      "payload": {"reason": "STORAGE_TEMP_FILE_MISSING"}
    }
  ]
}
```

```bash
# Telegram 버튼(재시도) 처리 시 OpenClaw가 호출할 API 예시
curl -X POST http://localhost:8000/api/ingest/actions/<JOB_ID>/retry \
  -H "X-OpenClaw-Action-Token: <signed-token>" \
  -H "Content-Type: application/json" \
  -d '{"clear_error":true}'
```

## 운영자 규칙 관리 + 백필 예시
```bash
# 1) ruleset 생성
curl -X POST http://localhost:8000/api/rulesets \
  -H 'Content-Type: application/json' \
  -d '{"name":"default-rules","description":"운영 기본 규칙셋"}'

# 2) rule version 추가
curl -X POST http://localhost:8000/api/rulesets/<RULESET_ID>/versions \
  -H 'Content-Type: application/json' \
  -d '{"rules_json":{"default_category":"기타","category_rules":[{"category":"회의","keywords":{"title":["회의"]},"tags":["회의"]}]}}'

# 3) 버전 활성화
curl -X POST http://localhost:8000/api/rule-versions/<RULE_VERSION_ID>/activate

# 4) 기존 데이터 백필
curl -X POST http://localhost:8000/api/rules/backfill \
  -H 'Content-Type: application/json' \
  -d '{"rule_version_id":"<RULE_VERSION_ID>","batch_size":500}'
```

## 구조 태그 백필(기존 문서 정리)
```bash
# 1) dry-run: 어떤 문서에 어떤 태그가 추가될지 미리 확인
python scripts/backfill_structured_tags.py --dry-run --limit 200

# 2) set 태그가 없는 문서만 실제 보강
python scripts/backfill_structured_tags.py --only-without-set --batch-size 500

# 3) telegram 소스 문서만 보강
python scripts/backfill_structured_tags.py --source telegram
```

## 리뷰 큐 일괄 처리 예시
```bash
# 검토 큐 조회
curl "http://localhost:8000/api/review-queue?page=1&size=50"

# 선택 문서 일괄 승인
curl -X POST http://localhost:8000/api/review-queue/bulk \
  -H 'Content-Type: application/json' \
  -d '{"document_ids":["<DOC_ID_1>","<DOC_ID_2>"],"update":{"approve":true,"note":"운영자 승인"}}'

# 단일 문서 수정(분류 + 날짜 보정)
curl -X PATCH http://localhost:8000/api/review-queue/<DOC_ID> \
  -H 'Content-Type: application/json' \
  -d '{"category_name":"회의","event_date":"2026-02-24","reason_remove":["CLASSIFY_FAIL","DATE_MISSING"]}'
```
