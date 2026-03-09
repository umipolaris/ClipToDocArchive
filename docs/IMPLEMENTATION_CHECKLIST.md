# 구현 체크리스트 (기준일: 2026-02-25)

## 1) 현재 완료된 핵심 항목
- [x] Telegram/API/CLI ingest 진입점 구현 (`/api/ingest/telegram`, `/api/ingest/manual`, `scripts/ingest_cli.py`)
- [x] 멀티 업로드 ingest 지원 (`/api/ingest/telegram|manual/batch`, CLI `--file` 반복 입력)
- [x] 문서 운영 편집 기능 확장(파일 삭제/교체 API, 수동 게시글 생성 API + UI)
- [x] 게시물 자체 편집/삭제 지원(`PATCH /api/documents/{id}`, `DELETE /api/documents/{id}` + Archive Detail UI)
- [x] 캡션 우선 파싱 규칙 적용 (제목 1행, 설명 나머지, 메타 `#분류/#날짜/#태그`)
- [x] 비동기 파이프라인 + 상태머신 (`RECEIVED~PUBLISHED/FAILED/NEEDS_REVIEW`)
- [x] 파일 해시 기반 저장 + 중복 감지(`files.checksum_sha256`)
- [x] PostgreSQL 스키마/인덱스/마이그레이션(Alembic)
- [x] Archive/Timeline/Search/Review Queue/Rules/Admin 기본 UI 구현
- [x] 규칙 버전 관리 + 룰 테스트 + 백필 실행 UI/API
- [x] Saved Filter(개인/공유) API + 검색 화면 연동
- [x] Admin 운영 로그/감사 로그 조회 + ingest job 재큐잉
- [x] 실패 job 파일 복구 업로드 + 재처리 API/UI
- [x] Docker Compose 기반 개발 구동 + Prometheus/기본 Alert 설정
- [x] CI 기본 파이프라인(backend pytest, frontend build, artifact/deploy workflow)
- [x] 마이그레이션 보조 스크립트 (`import_index_json.py`, `map_legacy_paths.py`, `validate_integrity.py`)
- [x] 레거시 `index.json` 실이관 스크립트 구현 (`scripts/import_index_json.py`, dry-run/리포트/누락정책)
- [x] 컷오버용 API 읽기전용 모드(`READ_ONLY_MODE`) + `/api/health` 노출
- [x] 검토 큐 반복 사유 자동 정리 스크립트(`scripts/review_queue_auto_resolve.py`)
- [x] 운영 UAT 스모크 점검 스크립트(`scripts/smoke_uat.py`)
- [x] 룰엔진 분류 개선(키워드 태그를 카테고리 추론 전에 반영) + review_only 백필 재적용
- [x] Archive 내 `세트/개정 보기` 화면 + `/api/archive/sets` 집계 API
- [x] 구조화 태그 자동 보강(`set/dockey/rev/kind/lang`) + 이스케이프 개행(`\\n`) 캡션 정규화

## 2) 앞으로 구현해야 할 항목 (우선순위)

### P0 (운영 안정화 필수)
- [x] ingest 재시도 정책 고도화: `retry_after` 기반 지수 백오프 + max attempts 초과 시 DLQ 분리 (`RETRY_SCHEDULED`/`DEAD_LETTER` 이벤트)
- [x] 파이프라인 단계별 장애코드 표준화(`STORAGE_TEMP_FILE_MISSING`, `DB_WRITE_FAIL`, `NOTIFY_CALLBACK_FAIL` 등) + Dashboard 실패코드 분포 노출
- [x] Telegram 회신 액션(재시도/재처리) 실버튼 연동 완성(OpenClaw callback 규약 확정 포함)

### P1 (규모 확장 대응)
- [x] `/api/documents` N+1 쿼리 제거(태그/파일수 집계 배치 조회로 전환, 2026-02-24)
- [x] 대량 데이터용 검색 확장: Meilisearch 옵션 구현 및 동기화 워커(선택 활성화, 2026-02-24)
- [x] `archive/sets` 성능 최적화: 대조인/그룹집계 제거 후 문서/태그/파일수 배치 조회로 전환(2026-02-24)
- [x] 프론트 대용량 목록 가상화(virtualized list/table, Archive/Search, 2026-02-24)
- [x] 서버사이드 정렬/필터 강화(`/api/documents sort_by/sort_order`, Archive/Search UI 반영, 2026-02-24)
- [x] 대용량 부하 테스트 자동화(k6 ingest/query 시나리오 + GitHub Actions 야간 실행, 2026-02-24)

### P2 (플랫폼 완성도)
- [x] 문서 버전 diff 뷰어(텍스트/PDF 요약 diff, 2026-02-24)
- [x] Rules UI 고급 기능(시뮬레이션 배치 비교, 충돌 규칙 탐지, 2026-02-24)
- [x] 운영 리포트 자동 발행(주간 오류율/분류 정확도/검토 큐 체류시간, Celery beat + Admin UI, 2026-02-24)
- [x] 감사 로그 검색 고도화(필드별 필터 + csv/json export, 2026-02-24)

## 3) 캡션/태그 운영 규약 (권장)
- [x] 운영자 가이드 배포: `set:*`, `dockey:*`, `rev:*`, `kind:*`, `lang:*` 표준 (`docs/OPERATIONS_TAG_GUIDE.md`)
- [x] 기존 문서 백필: 구조 태그 자동 보강 스크립트 제공 (`scripts/backfill_structured_tags.py`, 2026-02-24)
- [x] 신규 업로드 템플릿 고정(Manual Post UI 템플릿 모드 + 캡션 구조 검증, 2026-02-24):

```text
1행: 제목
2행+: 설명
#분류:회의
#날짜:2026-02-24
#태그:set:dcp,dockey:document-control-procedure,rev:2,kind:main
```

## 4) 단기 실행 순서 제안
- [x] 1주차: P0 재시도/DLQ + 에러코드 체계
- [x] 3주차: 성능 개선(`/documents` 쿼리/`archive/sets` 집계)
- [x] 4주차: Meilisearch 연동 + 야간 부하테스트 자동화

## 5) 범위 제외 항목(사용자 요청 반영)
- [x] 백업 암호화 + 복구 리허설 자동화
- [x] RBAC 세분화 + 민감 태그 접근제어
- [x] 로그 마스킹 강화
- [x] OIDC 인증 연동
- [x] 보안 주차(2주차) 항목

## 6) 2026-02-25 추가 진행 (단계형 점검 포함)
- [x] 아카이브 목록 밀도 토글(기본/컴팩트) 추가
- [x] 아카이브 컬럼 표시/순서 사용자 설정 UI 추가(로컬 저장)
- [x] 아카이브 키보드 이동 지원(↑/↓ 선택, Enter 상세)
- [x] 아카이브 사용자 설정 로직 분리(`frontend/lib/archive-list-preferences.ts`)
- [x] 단계형 중간점검 스크립트 추가(`infra/scripts/checkpoint-verify.sh`)
- [x] 유지보수 플레이북 문서화(`docs/MAINTENANCE_PLAYBOOK.md`)

## 7) 2026-02-26 카테고리 정합성 보정
- [x] 규칙셋 밖 카테고리 차단: rule_engine에서 허용 카테고리 화이트리스트 검증 적용
- [x] 태그 평문값 기반 임의 카테고리 승격 제거(규칙 기반 분류만 허용)
- [x] 실데이터 보정: `인허가` 1건을 `특수 인허가`로 정규화, `문서` 2건 규칙 백필 재분류
- [x] 운영 스크립트 추가: `scripts/check_out_of_rules_categories.py` (점검/자동수정)

## 8) 2026-02-26 UX/운영 보강
- [x] 아카이브 단축키 `Delete`(관리자 선택 문서 삭제) 지원
- [x] 아카이브 관리자 일괄 작업 바 sticky 고정
- [x] 파일 타입 아이콘 표준화(`FileTypeBadge`: PDF/XLSX/DOCX/IMG/PPT/ZIP/TXT)
- [x] 상태 배지 통합(`신규/검토필요/오류/완료/정상`)
- [x] 문서 상세 탭 분리(`메타/파일/버전/이력`)
- [x] 문서 이력 API 추가(`GET /api/documents/{id}/history`)
- [x] 아카이브 화면 프리셋(필터+정렬+컬럼+밀도) 저장/적용
- [x] 검색 화면 자주 쓰는 템플릿 프리셋 추가
- [x] 공통 컴포넌트화(`ModalShell`, `StatusBadge`, `FileTypeBadge`)
- [x] OpenAPI 계약 고정(`backend/scripts/export_openapi.py`, `frontend/lib/api-types.generated.ts`, CI diff check)
- [x] 마이그레이션 규칙 검사 스크립트(`backend/scripts/check_migration_rules.py`) + CI gate
- [x] 운영 지표/알림 보강(`ingest_success_rate_1h`, `ingest_jobs_backlog`, `search_request_duration_seconds`)
- [x] 릴리즈 체크리스트 및 stage 환경파일 추가(`docs/RELEASE_CHECKLIST.md`, `infra/env/.env.stage`)

## 9) 2026-03-09 대시보드 일정 연동/안정화
- [x] 회의 일정 수정 시 동일 날짜 아카이브 게시물 조회 + 첨부파일 선택 연동 UI 추가
- [x] 일정 저장 요청에 `linked_document_id`/`linked_file_id` 전달 및 서버 저장 검증(응답 불일치 시 에러 처리)
- [x] DB 스키마 확장: `dashboard_tasks.linked_document_id`, `linked_file_id` + FK/인덱스 (Alembic `0016_task_document_file_link`)
- [x] 일정 목록에 연결 첨부 확장자 아이콘/라벨 뱃지 추가 및 즉시 다운로드 지원
- [x] 일정 상세 페이지에 수정/삭제 액션 추가, 수정 시 대시보드 동일 수정 모달 연결
- [x] 일정 상세 페이지에 연결 첨부파일명 노출 + 다운로드 링크 추가
- [x] 일정 목록 기간 조회 race condition 완화(설정 로드 전 요청 차단 + 최신 요청만 반영)
