# Migration Runbook (index.json -> Archive DB)

## 0) Scope
- Source: legacy `index.json` + legacy file directory
- Target: PostgreSQL + object storage(minio/disk)
- Tooling:
  - `scripts/import_index_json.py`
  - `scripts/validate_integrity.py`

## 1) Preconditions
- `./scripts/compose.sh ps`에서 `api/postgres/minio`가 `Up` 상태
- 관리자 계정 확인 (`scripts/bootstrap_admin.py`)
- 이관 대상 파일 접근 가능 경로 확보
- 최소 2배 이상 디스크 여유 공간(백업 + 이관 작업분)

## 2) Backup (before any import)
아래는 기준 예시이며, 백업 파일명은 반드시 타임스탬프를 포함한다.

```bash
cd infra
ts=$(date +%Y%m%d_%H%M%S)
mkdir -p ./data/backup

# DB logical dump
./scripts/compose.sh exec -T postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' \
  > "./data/backup/db_${ts}.sql"

# MinIO volume snapshot
tar -czf "./data/backup/minio_${ts}.tar.gz" -C ./data minio
```

## 3) Dry-run import
먼저 반드시 dry-run으로 행 단위 결과를 확인한다.

```bash
cd infra
./scripts/compose.sh exec -T api sh -lc '
  cd /app &&
  PYTHONPATH=/app python scripts/import_index_json.py \
    --index-json /app/tmp/legacy_import_sample/index.json \
    --legacy-root /app/tmp/legacy_import_sample \
    --dry-run \
    --missing-file skip \
    --report /tmp/import_report.txt \
    --json-report /tmp/import_report.json
'
```

검토 포인트:
- `failed=0` 여부
- `skipped_missing_file` 비율
- `unknown_source_fallback` 발생 여부
- sample row에서 제목/분류/날짜/태그 기대값 일치 여부

## 4) Cut-over (read-only transition)
이관 순간의 데이터 드리프트를 막기 위해 write를 차단한다.

1. `infra/env/.env.common` 또는 `.env.dev`에서 `READ_ONLY_MODE=true`로 변경
2. 쓰기 워커 중지
3. API 재기동

```bash
cd infra
./scripts/compose.sh stop worker beat
./scripts/compose.sh up -d --build api
```

검증:

```bash
curl -s http://localhost:8000/api/health | jq .
# dependencies.read_only_mode == "enabled" 확인
```

## 5) Actual import

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

실패 행이 있으면 즉시 중단하고 원인(경로/권한/중복 정책) 확인 후 재실행.

## 6) Post-import integrity checks

```bash
cd infra
./scripts/compose.sh exec -T api sh -lc '
  cd /app &&
  PYTHONPATH=/app python scripts/validate_integrity.py \
    --report /tmp/integrity_report.txt \
    --json-report /tmp/integrity_report.json \
    --check-storage auto \
    --storage-probe-limit 5000 \
    --max-samples 20 \
    --fail-on-error
'
```

추가 확인:

```bash
cd infra
./scripts/compose.sh exec -T api alembic current
# 기대값: 0019_dashboard_milestones (head)
```

## 7) Re-open writes

1. `READ_ONLY_MODE=false`로 복귀
2. `worker/beat` 재가동

```bash
cd infra
./scripts/compose.sh up -d --build api worker beat
```

## 8) Rollback plan
조건:
- 이관 후 기능/정합성 오류가 임계치 이상
- 핵심 데이터 누락/오분류 다수 발생

절차:
1. 쓰기 정지: `READ_ONLY_MODE=true`, `worker/beat` 중지
2. API 정지: `./scripts/compose.sh stop api`
3. DB 복원: 백업 SQL 재적용
4. MinIO 복원: snapshot 압축 해제
5. 서비스 재기동 및 health 확인

예시:

```bash
cd infra
./scripts/compose.sh stop api worker beat

# DB restore
cat ./data/backup/db_YYYYMMDD_HHMMSS.sql | \
  ./scripts/compose.sh exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# MinIO restore
rm -rf ./data/minio
tar -xzf ./data/backup/minio_YYYYMMDD_HHMMSS.tar.gz -C ./data

./scripts/compose.sh up -d --build api worker beat minio
```

## 9) Exit criteria
- `/api/health` status `ok` 또는 허용 가능한 `degraded`
- integrity report에서 `errors=0`
- Archive 목록/검색/상세/다운로드 핵심 흐름 정상
- 운영자 샘플 검수(최소 30건) 완료
