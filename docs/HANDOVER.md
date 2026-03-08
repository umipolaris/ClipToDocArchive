# ClipToDocArchive 인수인계 문서

최종 업데이트: 2026-03-09 (KST)  
기준 브랜치: `main`

## 1) 프로젝트 개요
- 목적: Telegram/수동 게시 기반 문서 아카이브, 검색, 타임라인, 검토 큐, 규칙 엔진, 미디어 갤러리, 백업/복구 운영 기능 제공
- 핵심 스택:
  - Backend: FastAPI, Celery, Redis, PostgreSQL, MinIO
  - Frontend: Next.js + TypeScript + Tailwind + shadcn/ui
  - Infra: Docker Compose(+ Makefile 래퍼)

## 2) 현재 운영 기준
- 저장소명: `ClipToDocArchive`
- 기본 실행 포트:
  - Frontend `3000`
  - API `8000`
  - Postgres `5432`
  - Redis `6379`
  - MinIO `9000/9001`
  - Meilisearch `7700`
  - Prometheus `9090`

## 3) 빠른 실행 절차
```bash
make first-run
make bootstrap-admin ADMIN_USER=admin ADMIN_PASS='ChangeMe123!'
```

- `make first-run`:
  - 누락된 env 자동 생성(`infra/env/.env.common`, `infra/env/.env.dev`)
  - Docker 사전 점검
  - 스택 기동 + API healthcheck 대기
- `make bootstrap-admin`:
  - API 미기동이면 자동 기동/대기 후 관리자 계정 생성

## 4) 자주 쓰는 운영 명령
```bash
make ps
make logs
make health
make down
make restart
```

## 5) 백업/복구 체계 (운영 중요)
- 백업:
```bash
make backup-db
make backup-objects
make backup-config
make backup-all
```
- 복구:
```bash
make restore-db BACKUP_FILE=<db_dump> CONFIRM=YES
make restore-objects BACKUP_FILE=<objects_tar> CONFIRM=YES
make restore-config BACKUP_FILE=<config_tar> MODE=apply CONFIRM=YES
make promote-db SOURCE_DB=archive_restore_test CONFIRM=YES
```
- 웹 관리자 페이지에서도 백업/복구 업로드 및 진행률 UI 지원
- 자동 백업 스케줄(ON/OFF, 1~60일, 시간 지정) 지원

## 6) 자동 시작(재부팅 후)
- macOS: `launchd` 스크립트 지원 (`infra/scripts/install-autostart-macos.sh`)
- Linux(systemd): 서비스 등록 권장
  - 주의: `ExecStart`는 `up -d` 사용(부팅 시 `--build` 비권장)
  - 빌드는 별도 수동 실행:
```bash
cd /home/www/board/ClipToDocArchive/infra
docker compose --env-file ./env/.env.common --env-file ./env/.env.dev build --pull
```

## 7) 데이터/파일 실제 저장 위치
- DB 데이터: Docker volume(`postgres`)
- 오브젝트(원본 첨부): MinIO 버킷(또는 로컬 fallback 설정 시 디스크)
- 백업 파일: `infra/data/backup/*` (설정에 따라 호스트 경로 복사 가능)
- 로그: `infra/data/logs/*`

## 8) 최근 반영된 주요 기능
- 아카이브/상세/편집 UX 개선(간편게시, 상세게시, 코멘트, 문서 상세 동작 개선)
- 규칙 기반 분류/태그/카테고리 보강 및 수동게시 개선
- 미디어 갤러리(이미지/영상 다중 업로드, 갤러리형 표시)
- 대시보드 일정 목록 + 캘린더 연동
- 백업/복구 UI, 진행률, 자동 백업 스케줄
- Linux/Ubuntu 부팅/초기 실행 안정화(`ensure-env`, `ensure-api` 보강)

## 9) 인수인계 체크리스트
- 신규 서버에서 아래 순서로 검증:
1. `make first-run` 성공
2. `make bootstrap-admin ...` 성공
3. `http://<host>:3000/archive` 로그인
4. 문서 업로드/검색/상세/코멘트 확인
5. 백업 생성 후 복구(테스트 DB) 및 `promote-db` 검증
6. 재부팅 후 자동 기동 검증(`docker ps`, 로그인 확인)

## 10) 주의사항
- 개인 정보/실데이터/비밀번호는 Git 커밋 금지
- `.env.*`는 운영 환경별로 분리 관리
- 복구 직후 세션 이슈가 있으면 브라우저 새로고침 후 재로그인
- 포트 충돌 시 `make doctor` 결과를 먼저 확인
