from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Document Archive API"
    env: str = "dev"
    api_prefix: str = "/api"
    api_base_url: str = "http://localhost:8000/api"

    database_url: str = Field(
        default="postgresql+psycopg://archive:archive_pw@postgres:5432/archive"
    )
    redis_url: str = "redis://redis:6379/0"
    ingest_retry_base_seconds: int = 30
    ingest_retry_max_seconds: int = 1800

    storage_backend: str = "minio"
    storage_bucket: str = "archive"
    storage_disk_root: str = "/data/archive"

    minio_endpoint: str = "minio:9000"
    minio_access_key: str = "minio"
    minio_secret_key: str = "minio_secret"
    minio_secure: bool = False

    session_secret: str = "change-me"
    session_cookie_name: str = "archive_session"
    session_max_age_seconds: int = 60 * 60 * 8
    session_cookie_max_age_seconds: int = 60 * 60 * 24 * 366
    session_https_only: bool = False
    session_same_site: str = "lax"
    read_only_mode: bool = False

    password_min_length: int = 10
    auth_max_failed_attempts: int = 5
    auth_lockout_seconds: int = 900
    auth_auto_login_days: int = 7

    openclaw_callback_url: str = "http://openclaw:8080/callback/ingest"
    openclaw_notify_enabled: bool = False
    openclaw_action_secret: str = "change-me-openclaw-action-secret"
    openclaw_action_ttl_seconds: int = 86400
    frontend_base_url: str = "http://localhost:3000"
    cors_allow_origins: list[str] = ["http://localhost:3000"]

    search_backend: str = "postgres"
    search_auto_sync: bool = True
    meili_url: str = "http://meilisearch:7700"
    meili_api_key: str | None = None
    meili_index_documents: str = "documents"
    meili_timeout_seconds: float = 3.0

    backup_root: str = "/backup"
    backup_export_root: str = "/backup-export"
    backup_config_root: str = "/config"
    backup_retention_days: int = 30
    backup_schedule_timezone: str = "Asia/Seoul"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
