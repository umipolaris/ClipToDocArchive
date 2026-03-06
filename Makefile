SHELL := /bin/sh

APP_PROFILE ?= dev
ADMIN_USER ?= admin
ADMIN_PASS ?= ChangeMe123!

.PHONY: ensure-env doctor up down restart ps logs health wait-api first-run bootstrap-admin install-hooks guard-staged guard-all backup-db backup-objects backup-config backup-all restore-db restore-objects restore-config promote-db

ensure-env:
	@if [ ! -f "infra/env/.env.common" ]; then \
	  if [ -f "infra/env/.env.common.example" ]; then \
	    cp infra/env/.env.common.example infra/env/.env.common; \
	    echo "[bootstrap] 생성: infra/env/.env.common (from .env.common.example)"; \
	  else \
	    echo "[error] infra/env/.env.common 없음, .env.common.example도 없습니다."; \
	    exit 1; \
	  fi; \
	fi
	@if [ ! -f "infra/env/.env.$(APP_PROFILE)" ]; then \
	  if [ -f "infra/env/.env.$(APP_PROFILE).example" ]; then \
	    cp "infra/env/.env.$(APP_PROFILE).example" "infra/env/.env.$(APP_PROFILE)"; \
	    echo "[bootstrap] 생성: infra/env/.env.$(APP_PROFILE) (from .env.$(APP_PROFILE).example)"; \
	  fi; \
	fi

doctor: ensure-env
	@./infra/scripts/doctor.sh

up: ensure-env doctor
	@cd infra && APP_PROFILE=$(APP_PROFILE) ./scripts/compose.sh up -d --build

down: ensure-env
	@cd infra && APP_PROFILE=$(APP_PROFILE) ./scripts/compose.sh down

restart: ensure-env
	@cd infra && APP_PROFILE=$(APP_PROFILE) ./scripts/compose.sh down && APP_PROFILE=$(APP_PROFILE) ./scripts/compose.sh up -d --build

ps: ensure-env
	@cd infra && APP_PROFILE=$(APP_PROFILE) ./scripts/compose.sh ps

logs: ensure-env
	@cd infra && APP_PROFILE=$(APP_PROFILE) ./scripts/compose.sh logs -f --tail=200

health:
	@curl -fsS http://localhost:8000/api/health | jq . || curl -fsS http://localhost:8000/api/health

wait-api:
	@i=0; \
	until curl -fsS http://localhost:8000/api/health >/dev/null 2>&1; do \
	  i=$$((i+1)); \
	  if [ $$i -ge 60 ]; then \
	    echo "API healthcheck timeout (120s)"; \
	    exit 1; \
	  fi; \
	  sleep 2; \
	done; \
	echo "API is healthy"

first-run: ensure-env doctor up wait-api
	@echo "다음 단계: make bootstrap-admin ADMIN_USER=admin ADMIN_PASS='ChangeMe123!'"

bootstrap-admin: ensure-env
	@cd infra && APP_PROFILE=$(APP_PROFILE) ./scripts/compose.sh exec -T api sh -lc "cd /app && python scripts/bootstrap_admin.py --username '$(ADMIN_USER)' --password '$(ADMIN_PASS)'"

install-hooks:
	@git config core.hooksPath .githooks
	@chmod +x .githooks/pre-commit .githooks/pre-push scripts/check_sensitive_guard.sh
	@echo "git hooks installed (.githooks)"

guard-staged:
	@./scripts/check_sensitive_guard.sh --staged

guard-all:
	@./scripts/check_sensitive_guard.sh --all

backup-db: ensure-env
	@cd infra && APP_PROFILE=$(APP_PROFILE) ./scripts/db-backup.sh

backup-objects: ensure-env
	@cd infra && APP_PROFILE=$(APP_PROFILE) ./scripts/backup-objects.sh

backup-config: ensure-env
	@cd infra && APP_PROFILE=$(APP_PROFILE) ./scripts/backup-config.sh

backup-all: backup-db backup-objects backup-config
	@echo "all backup steps completed"

restore-db: ensure-env
	@if [ -z "$(BACKUP_FILE)" ]; then \
	  echo "Usage: make restore-db BACKUP_FILE=./infra/data/backup/db/archive_YYYYMMDD_HHMMSS.dump CONFIRM=YES"; \
	  exit 1; \
	fi
	@cd infra && APP_PROFILE=$(APP_PROFILE) CONFIRM=$(CONFIRM) TARGET_DB=$(TARGET_DB) ./scripts/db-restore.sh "$(BACKUP_FILE)"

restore-objects: ensure-env
	@if [ -z "$(BACKUP_FILE)" ]; then \
	  echo "Usage: make restore-objects BACKUP_FILE=./infra/data/backup/objects/objects_snapshot_minio_YYYYMMDD_HHMMSS.tar.gz CONFIRM=YES"; \
	  exit 1; \
	fi
	@cd infra && APP_PROFILE=$(APP_PROFILE) CONFIRM=$(CONFIRM) TARGET_DIR=$(TARGET_DIR) ./scripts/restore-objects.sh "$(BACKUP_FILE)"

restore-config: ensure-env
	@if [ -z "$(BACKUP_FILE)" ]; then \
	  echo "Usage: make restore-config BACKUP_FILE=./infra/data/backup/config/config_YYYYMMDD_HHMMSS.tar.gz MODE=preview"; \
	  exit 1; \
	fi
	@cd infra && APP_PROFILE=$(APP_PROFILE) MODE=$(MODE) CONFIRM=$(CONFIRM) ./scripts/restore-config.sh "$(BACKUP_FILE)"

promote-db: ensure-env
	@if [ -z "$(SOURCE_DB)" ]; then \
	  echo "Usage: make promote-db SOURCE_DB=archive_restore_test CONFIRM=YES"; \
	  exit 1; \
	fi
	@cd infra && APP_PROFILE=$(APP_PROFILE) CONFIRM=$(CONFIRM) ACTIVE_DB=$(ACTIVE_DB) ./scripts/db-promote-restore.sh "$(SOURCE_DB)"
