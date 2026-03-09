# ClipToDocArchive 인수인계 문서 (상세 운영판)

최종 업데이트: 2026-03-09 (KST)  
기준 브랜치: `main`  
대상 독자: 신규 운영자, 신규 개발자, 타 서버 이관 담당자

---

## 0) 이 문서의 목적

이 문서는 다음 3가지를 바로 수행할 수 있게 만드는 인수인계 문서다.

1. 신규 서버에서 시스템을 **즉시 기동**하고 관리자 로그인까지 완료
2. 백업/복구 및 자동 백업 스케줄을 포함한 **운영 안정화**
3. 기존 개발 맥락(구조/규칙/주의사항)을 잃지 않고 **개발 연속성 확보**

---

## 1) 시스템 개요

### 1-1. 제품 역할

ClipToDocArchive는 문서/파일 업로드를 운영 가능한 아카이브로 전환하는 플랫폼이다.

- 입력: Telegram 연동 ingest + 웹 간편게시 + 웹 상세게시 + 수동 파일 첨부
- 처리: 제목/설명/날짜/분류/태그 추출, 중복 감지, 색인
- 운영: 검토 큐, 규칙 엔진, 문서 편집/버전 이력, 감사 로그, 백업/복구
- 탐색: 아카이브, 타임라인, 고급 검색, 마인드맵, 미디어 갤러리

### 1-2. 상위 아키텍처(런타임)

```text
[Telegram/OpenClaw/웹 업로드]
            |
            v
       [FastAPI API] <------ [Next.js Frontend]
            |                        |
            | enqueue                | REST/Session
            v                        |
      [Redis broker/backend]         |
            |                        |
            v                        |
      [Celery Worker/Beat] ----------+
            |
            +--> [PostgreSQL] (메타/색인/규칙/로그/세션정책)
            |
            +--> [MinIO or Disk] (원본 첨부)
            |
            +--> [Meilisearch(optional)]
```

---

## 2) 저장소 구조와 책임 범위

| 경로 | 역할 | 비고 |
| --- | --- | --- |
| `backend/app` | API/서비스/DB 모델/워커 태스크 | FastAPI + SQLAlchemy + Celery |
| `backend/app/api/v1` | 라우터 집합 | 문서/인증/백업/대시보드/브랜딩 등 |
| `backend/app/db/models.py` | 핵심 테이블/인덱스 정의 | 운영 데이터 구조의 기준 |
| `backend/app/services` | ingest/search/backup 서비스 로직 | 백업 포맷/복구 검증 포함 |
| `backend/scripts` | 운영/마이그레이션/관리 스크립트 | `bootstrap_admin.py` 등 |
| `frontend/app` | 페이지 라우팅 | Archive, Dashboard, Admin, Mindmap |
| `frontend/components` | UI 컴포넌트 | 표/모달/편집기/갤러리 |
| `frontend/openapi/openapi.json` | API 계약 스냅샷 | CI에서 drift 검사 |
| `frontend/lib/api-types.generated.ts` | OpenAPI 타입 생성물 | 프론트 타입 안정성 |
| `infra/docker-compose.yml` | 컨테이너 오케스트레이션 | dev/prod profile 포함 |
| `infra/env` | 환경변수 템플릿/실제 env | `.example`만 Git 관리 |
| `infra/scripts` | compose 래퍼, doctor, 백업/복구 셸 | 운영 Runbook 핵심 |
| `docs` | 운영 문서/체크리스트/런북 | 본 파일 포함 |

---

## 3) 런타임 컴포넌트 상세

### 3-1. 서비스 목록 (Compose)

| 서비스 | 이미지/빌드 | 포트 | 역할 |
| --- | --- | --- | --- |
| `postgres` | `postgres:15` | `5432` | 메인 DB |
| `redis` | `redis:7` | `6379` | Celery broker/result |
| `minio` | `minio/minio` | `9000`,`9001` | 오브젝트 저장소 + 콘솔 |
| `meilisearch` | `getmeili/meilisearch:v1.12` | `7700` | 선택 검색 백엔드 |
| `api` | `../backend/Dockerfile` | `8000` | FastAPI + Alembic migrate |
| `worker` | `../backend/Dockerfile` | - | ingest/backfill/search/reports 큐 처리 |
| `beat` | `../backend/Dockerfile` | - | 주기 태스크(주간리포트/자동백업 검사) |
| `frontend` | `../frontend/Dockerfile` | `3000` | Next.js UI |
| `prometheus` | `prom/prometheus` | `9090` | 메트릭 수집 |
| `backup` | `alpine` (prod profile) | - | cron 기반 백업 보조(선택) |

### 3-2. 영속 데이터 경로

| 경로 | 내용 |
| --- | --- |
| `infra/data/postgres` | PostgreSQL 물리 데이터 |
| `infra/data/minio` | MinIO 오브젝트 데이터 |
| `infra/data/archive` | `STORAGE_BACKEND=disk` fallback 저장소 |
| `infra/data/backup/db` | DB 백업 `.dump` |
| `infra/data/backup/objects` | 첨부 백업 `.tar.gz` |
| `infra/data/backup/config` | 설정 백업 `.tar.gz` |
| `infra/data/backup_export` | 스케줄 백업 외부 복사용 기본 루트 |
| `infra/data/ingest_tmp` | ingest 임시 파일 |
| `infra/data/logs` | autostart/운영 로그 |

### 3-3. 데이터가 Git에 커밋되지 않는 경로

`.gitignore` 기준:

- `infra/data/`
- `infra/env/.env*` (단, `.example` 제외)
- `*.dump`, `*.tgz`
- `node_modules/`, `.next/`

---

## 4) 핵심 도메인 규칙 (깨지면 운영 품질 하락)

### 4-1. 캡션 우선 규칙

1. `title = caption 첫 줄`
2. `description = caption 나머지`
3. 캡션 없으면 파일명/추론 요약 fallback
4. 파일명은 보조 메타데이터로 취급

### 4-2. 메타 라인 파싱

캡션/설명에 아래 형식을 허용:

- `#분류:<값>`
- `#날짜:<값>`
- `#태그:<csv>`

### 4-3. ingest 상태머신

`IngestState`:

- `RECEIVED`
- `STORED`
- `EXTRACTED`
- `CLASSIFIED`
- `INDEXED`
- `PUBLISHED`
- `FAILED`
- `NEEDS_REVIEW`

보조 이벤트는 `ingest_events`에 누적된다.

### 4-4. 재시도/실패 운영 포인트

- 재시도 시간은 `retry_after` + 지수 백오프
- 최대 시도 초과 시 `FAILED` 또는 `NEEDS_REVIEW`
- 운영자는 Admin에서 job 이벤트 조회 후 재큐잉/복구 업로드 가능

---

## 5) DB 모델 요약

핵심 테이블:

- 사용자/정책: `users`, `security_policies`
- 문서/분류: `documents`, `document_versions`, `categories`, `document_categories`
- 파일/태그: `files`, `document_files`, `tags`, `document_tags`
- 코멘트/고정글: `document_comments`, `documents.is_pinned`
- ingest 추적: `ingest_jobs`, `ingest_events`
- 규칙/백필: `rulesets`, `rule_versions`
- 운영/감사: `audit_logs`, `saved_filters`
- 대시보드 일정: `dashboard_tasks`, `dashboard_task_settings`
  - `dashboard_tasks` 주요 확장 컬럼: `linked_document_id`, `linked_file_id` (회의 일정-회의록 첨부 연동)
- 브랜딩/백업설정: `branding_settings`, `backup_schedule_settings`

인덱스 주요 포인트:

- `documents(event_date desc)`
- `documents(category_id, event_date desc)`
- `documents.search_vector` GIN
- `files(checksum_sha256)` unique
- Telegram source_ref partial unique:
  - `uq_documents_source_ref_telegram`
  - `uq_ingest_jobs_source_ref_telegram`

---

## 6) API 핵심 그룹

### 6-1. 인증/사용자

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/change-password`
- `GET/PATCH /api/admin/security-policy`
- `GET/POST/PATCH/DELETE /api/admin/users`

### 6-2. 문서/코멘트/파일

- `POST /api/ingest/telegram`
- `POST /api/ingest/manual`
- `GET /api/documents`
- `GET/PATCH/DELETE /api/documents/{id}`
- `POST /api/documents/{id}/reclassify`
- `GET /api/documents/{id}/comments`
- `POST /api/documents/{id}/comments`
- `PATCH/DELETE /api/documents/{id}/comments/{comment_id}`

### 6-3. 규칙/검토/탐색

- `POST /api/rules/test`
- `POST /api/rules/backfill`
- `GET /api/review-queue`
- `GET /api/timeline`
- `GET /api/mindmap/tree`

### 6-4. 대시보드 일정

- `GET/POST /api/dashboard/tasks`
- `GET/PATCH/DELETE /api/dashboard/tasks/{task_id}`
- `GET/PUT /api/dashboard/task-settings`
- 일정 조회 응답에 첨부 연동 메타 포함:
  - `linked_document_id`, `linked_document_title`
  - `linked_file_id`, `linked_file_name`, `linked_file_download_path`

### 6-5. 브랜딩/백업복구

- `GET /api/branding/logo`
- `GET /api/branding/logo/image`
- `POST/DELETE /api/admin/branding/logo`
- `GET/DELETE /api/admin/backups/files...`
- `POST /api/admin/backups/run/{kind}`
- `POST /api/admin/backups/run-all`
- `GET/POST /api/admin/backups/schedule`
- `POST /api/admin/backups/schedule/run-now`
- `POST /api/admin/backups/restore/*`
- `POST /api/admin/backups/upload-and-restore/*`

---

## 7) 신규 서버 세팅 Runbook (Day 0)

### 7-1. 필수 선행조건

1. Docker daemon 동작
2. Compose plugin 동작 (`docker compose`)
3. 포트 충돌 없음
4. 저장 경로 쓰기 권한 확보

### 7-2. 설치/초기 기동

```bash
git clone https://github.com/umipolaris/ClipToDocArchive.git
cd ClipToDocArchive
make first-run
make bootstrap-admin ADMIN_USER=admin ADMIN_PASS='ChangeMe123!'
```

`make first-run`은 아래를 수행한다:

- env 누락 시 `.example`에서 자동 생성
- `infra/scripts/doctor.sh` 사전 점검
- compose up
- API healthcheck 대기

`make bootstrap-admin`은 아래를 수행한다:

- API 미기동이면 자동 기동 (`ensure-api`)
- healthcheck 대기 후 `bootstrap_admin.py` 실행

### 7-3. 접속 확인

- UI: `http://<host>:3000/archive`
- API health: `http://<host>:8000/api/health`
- MinIO console: `http://<host>:9001`
- Prometheus: `http://<host>:9090`

### 7-4. 대표 장애 포인트

- `service "api" is not running`: 먼저 `make first-run`
- `.env.common not found`: `make` 타깃으로 실행하면 자동생성
- 부팅 후 `Failed to fetch`: CORS/세션 도메인, API URL 설정 점검

---

## 8) 운영 명령어 치트시트

```bash
make doctor
make up
make down
make restart
make ps
make logs
make health
make bootstrap-admin ADMIN_USER=admin ADMIN_PASS='...'
```

백업/복구:

```bash
make backup-db
make backup-objects
make backup-config
make backup-all

make restore-db BACKUP_FILE=... CONFIRM=YES
make restore-objects BACKUP_FILE=... CONFIRM=YES
make restore-config BACKUP_FILE=... MODE=preview
make restore-config BACKUP_FILE=... MODE=apply CONFIRM=YES
make promote-db SOURCE_DB=archive_restore_test CONFIRM=YES
```

---

## 9) 백업/복구 운영 상세

### 9-1. 백업 파일 형식

| 종류 | 확장자 | 유효성 검증 |
| --- | --- | --- |
| DB | `.dump` | SHA256/meta 검증 |
| Objects | `.tar.gz` (업로드 시 `.tgz` 허용 후 변환) | format/layout/meta 검증 |
| Config | `.tar.gz` | 허용 경로(`env`,`monitoring`,`docker-compose.yml`) 검증 |

업로드 복구 시 파일명 규칙:

- DB는 `.dump` 필수
- Objects/Config는 `.tar.gz` 필수 (`.tgz` 자동 교정)

### 9-2. UI 복구 시 `preview` vs `apply`

- `preview`: 설정 파일 변경 예정 목록만 출력, 실제 반영 없음
- `apply`: 실제 반영 수행, `confirm=true` 필수

### 9-3. DB 복구 핵심

DB 복구는 기본적으로 복구용 DB(`archive_restore`)에 넣고,
필요 시 승격(`promote_to_active=true` 또는 `make promote-db`)으로 운영 DB를 교체한다.

권장 절차:

1. DB 복구
2. 게시물 리스트 확인
3. Objects 복구
4. 첨부 다운로드 확인
5. 필요 시 config apply
6. 운영 DB 승격 및 재로그인 확인

### 9-4. 복구 후 세션 이슈

복구/승격 직후 다음이 발생할 수 있다:

- `401 invalid session`
- 로그인 화면 루프

대응:

1. 브라우저 새로고침
2. 재로그인
3. 필요 시 API/프론트 재시작

### 9-5. 백업 일관성 포인트

- `run-all`은 내부 체크포인트로 consistency window 위반 시 실패 처리
- 실패 시 생성 중 아티팩트 안전 정리
- 감사로그(`audit_logs`)에 백업/복구 이벤트 기록

---

## 10) 자동 백업 스케줄 상세

### 10-1. 동작 원리

- Celery beat가 1분마다 `run_scheduled_full_backup_task` 실행
- `enabled=true`일 때만 수행
- `interval_days(1~60)`, `run_time(HH:MM)`, `target_dir`에 따라 due 계산
- 시간대는 `BACKUP_SCHEDULE_TIMEZONE` (기본 `Asia/Seoul`)

### 10-2. 필수 전제

아래 서비스가 살아 있어야 자동 백업이 돈다.

- `api`
- `worker`
- `beat`

### 10-3. 자주 막히는 원인

1. `beat` 죽어 있음
2. `enabled=false`
3. `target_dir` 권한 부족
4. 스케줄 변경 후 기대 시각 오해 (변경 시 run window 리셋)

### 10-4. 즉시 실행

- UI: `Admin > 백업/복구 > 지금 실행`
- API: `POST /api/admin/backups/schedule/run-now`

---

## 11) 재부팅 자동 시작

### 11-1. Linux(systemd) 권장 설정

중요: systemd `ExecStart`에서 `--build`를 빼야 부팅 안정성이 올라간다.

```ini
[Unit]
Description=ClipToDocArchive Docker Compose Stack
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
WorkingDirectory=/home/www/board/ClipToDocArchive/infra
RemainAfterExit=yes
ExecStart=/usr/bin/docker compose --env-file ./env/.env.common --env-file ./env/.env.dev up -d
ExecStop=/usr/bin/docker compose --env-file ./env/.env.common --env-file ./env/.env.dev down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

빌드는 배포 시 수동:

```bash
cd /home/www/board/ClipToDocArchive/infra
docker compose --env-file ./env/.env.common --env-file ./env/.env.dev build --pull
```

### 11-2. macOS 자동 시작

- `infra/scripts/install-autostart-macos.sh` 사용
- 로그: `infra/data/logs/com.umipolaris.docarchive.autostart.*.log`

---

## 12) 서버 이관 절차 (운영 데이터 포함)

### 12-1. 소스 서버

1. `make backup-all`
2. 백업 파일(`infra/data/backup/*`) 확보
3. 필요 시 `.env` 계열 안전 전달(암호화 채널 권장)
4. Git 최신 push

### 12-2. 타깃 서버

1. 저장소 clone
2. `make first-run`
3. 관리자 계정 생성
4. 백업 업로드 복구(DB -> Objects -> Config 순)
5. 필요 시 DB 승격
6. 앱 점검(목록/검색/첨부다운로드/대시보드/백업 페이지)

### 12-3. 검증 기준

- 아카이브 목록 정상
- 첨부 다운로드 정상
- 규칙 페이지 로딩 정상
- 대시보드 일정 목록 정상
- 백업 파일 목록 조회 정상

---

## 13) 개발 워크플로우

### 13-1. API 계약(OpenAPI) 동기화

CI `api_contract`는 생성물 drift를 차단한다.

```bash
cd frontend
npm run gen:api-types
git diff -- frontend/openapi/openapi.json frontend/lib/api-types.generated.ts
```

CI 실패 메시지:

- `Ensure generated artifacts are committed`

대응:

1. 위 명령으로 생성물 갱신
2. 생성물 커밋

### 13-2. 테스트/빌드

Backend:

```bash
cd backend
pip install .[test]
python scripts/check_migration_rules.py
pytest -q
```

Frontend:

```bash
cd frontend
npm ci || npm install
npm run build
```

### 13-3. CI 워크플로우 파일

- `.github/workflows/ci.yml`
- `.github/workflows/privacy-guard.yml`
- `.github/workflows/build-artifact.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/nightly-load-test.yml`

---

## 14) 운영 보안/개인정보 수칙

1. 개인 파일/실데이터/개인 계정 비밀번호는 절대 커밋 금지
2. `.env`는 Git 제외, `.example`만 공유
3. 커밋 전 가드:
   - `scripts/check_sensitive_guard.sh --staged`
4. 필요 시 전체 점검:
   - `scripts/check_sensitive_guard.sh --all`

---

## 15) 장애 대응 매트릭스

| 증상 | 주 원인 | 조치 |
| --- | --- | --- |
| `bootstrap-admin` 정지처럼 보임 | API 미기동/헬스체크 대기 | `make ps`, `make logs`로 API 확인 |
| systemd 시작 실패 + `failed to resolve source metadata` | 부팅 시 `--build` + 네트워크/레지스트리 이슈 | systemd에서 `--build` 제거, 빌드 수동 실행 |
| 외부 IP 접속 시 로그인 `Failed to fetch` | API base/CORS/세션 설정 부정합 | `API_BASE_URL`, `FRONTEND_BASE_URL`, `cors_allow_origins` 점검 |
| 백업 복구 후 401/세션 오류 | DB 승격 후 세션 갱신 필요 | 새로고침 후 재로그인 |
| 자동 백업 미실행 | beat 미기동 또는 schedule off | `make ps`에서 beat 확인, Admin schedule 상태 확인 |
| 첨부 복구 API 400 | 확장자/포맷 불일치 | objects/config는 `.tar.gz`, db는 `.dump` 사용 |
| 일정 첨부 연결 저장 실패 (`서버(DB)에 저장되지 않았습니다`) | 대시보드 첨부연동 마이그레이션 미적용 | `alembic current` 확인 후 `0016_task_document_file_link`까지 `alembic upgrade head`, `api/frontend` 재시작 |

---

## 16) 운영자가 자주 헷갈리는 포인트

1. `preview`는 설정 반영이 아니다.
2. DB 복구만 하면 첨부는 비어 있을 수 있다. Objects 복구를 별도 수행해야 한다.
3. `promote-db`는 운영 DB를 교체한다. 반드시 확인 후 실행해야 한다.
4. 자동 백업은 `beat`가 죽으면 동작하지 않는다.
5. Linux 자동기동에서 `--build`는 실패 확률을 올린다.
6. 일정 첨부 연동 기능은 DB 리비전 `0016_task_document_file_link` 적용 전에는 정상 저장되지 않는다.

---

## 17) 남은 기술부채/개선 후보

1. 운영 환경용 domain/SSL 기반 CORS/세션 표준 템플릿 정리
2. systemd 자동설치 스크립트(`install-systemd-linux.sh`) 추가
3. 백업 복구 E2E 자동화 테스트 강화(대용량 objects 시나리오)
4. 장애 시 자동 진단 리포트(로그 번들러) 추가

---

## 18) 인수인계 최종 체크리스트 (실행형)

1. 소스코드 pull + 브랜치 확인
2. `make first-run` 성공
3. `make bootstrap-admin` 성공
4. 로그인/권한 테스트 성공
5. 문서 등록/수정/삭제/코멘트 성공
6. 백업 생성 성공
7. 업로드 복구(DB/Objects/Config) 성공
8. 자동 백업 스케줄 ON 후 `run-now` 성공
9. 재부팅 후 자동 기동 성공
10. OpenAPI 타입 생성 drift 없음 확인

---

## 19) 참조 문서

- `README.md`
- `docs/IMPLEMENTATION_CHECKLIST.md`
- `docs/MAINTENANCE_PLAYBOOK.md`
- `docs/MIGRATION_RUNBOOK.md`
- `docs/RELEASE_CHECKLIST.md`
- `infra/scripts/restore-runbook.md`

---

## 20) 인수인계 메모 (업데이트 규칙)

이 문서는 운영/개발 변경이 발생할 때 반드시 갱신한다.

- 백업/복구 동작 변경
- 자동기동 방식 변경
- 주요 API 경로 추가/삭제
- DB 스키마(테이블/인덱스) 변경
- 배포/CI 파이프라인 변경

---

## 21) 최근 업데이트 메모 (2026-03-09)

1. 대시보드 일정에 회의록 첨부 연동 추가
   - 일정 수정(회의 카테고리)에서 해당 날짜의 아카이브 게시물 목록 조회
   - 게시물 선택 후 첨부파일 선택/저장
   - 일정 API 응답에 연결 첨부 메타(`linked_*`) 제공
2. 일정 UI 보강
   - 일정 목록: 연결 첨부를 확장자 아이콘/라벨 뱃지로 표시, 클릭 즉시 다운로드
   - 일정 상세: 첨부파일명 노출 + 다운로드 링크 제공
   - 일정 상세: 수정/삭제 버튼 추가, 수정 시 대시보드 동일 수정 모달 호출
3. 일정 목록 기간 안정화
   - 설정 로드 전 기본 범위 요청 차단
   - 비동기 경합 시 최신 요청만 반영하도록 목록 요청 시퀀스 보호
4. DB 스키마 확장
   - Alembic `0016_task_document_file_link`
   - `dashboard_tasks.linked_document_id`, `linked_file_id` 컬럼 + FK/인덱스 추가
