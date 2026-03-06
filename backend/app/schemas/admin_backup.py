from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

BackupKind = Literal["db", "objects", "config"]
ConfigRestoreMode = Literal["preview", "apply"]


class BackupFileItem(BaseModel):
    kind: BackupKind
    filename: str
    size_bytes: int
    created_at: datetime
    sha256: str | None = None
    download_url: str


class BackupFilesResponse(BaseModel):
    kind: BackupKind
    items: list[BackupFileItem] = Field(default_factory=list)


class BackupRunResponse(BaseModel):
    kind: BackupKind
    filename: str
    size_bytes: int
    created_at: datetime
    sha256: str | None = None


class BackupRunAllResponse(BaseModel):
    items: list[BackupRunResponse] = Field(default_factory=list)


class BackupDeleteResponse(BaseModel):
    status: str
    kind: BackupKind
    filename: str
    meta_deleted: bool = False


class BackupDeleteAllResponse(BaseModel):
    status: str
    deleted_total: int
    deleted_meta_total: int
    deleted_by_kind: dict[str, int] = Field(default_factory=dict)
    meta_deleted_by_kind: dict[str, int] = Field(default_factory=dict)
    errors: list[str] = Field(default_factory=list)


class BackupRestoreDbRequest(BaseModel):
    filename: str
    target_db: str = "archive_restore"
    confirm: bool = False
    promote_to_active: bool = False


class BackupRestoreObjectsRequest(BaseModel):
    filename: str
    replace_existing: bool = True
    confirm: bool = False


class BackupRestoreConfigRequest(BaseModel):
    filename: str
    mode: ConfigRestoreMode = "preview"
    confirm: bool = False


class BackupRestoreDbResponse(BaseModel):
    status: str
    filename: str
    target_db: str
    promoted: bool = False
    promoted_from: str | None = None


class BackupRestoreObjectsResponse(BaseModel):
    status: str
    filename: str
    restored_count: int
    replace_existing: bool


class BackupRestoreConfigResponse(BaseModel):
    status: str
    filename: str
    mode: ConfigRestoreMode
    total_files: int
    files: list[str] = Field(default_factory=list)


class BackupScheduleSettingsUpdateRequest(BaseModel):
    enabled: bool = False
    interval_days: int = Field(1, ge=1, le=60)
    run_time: str = Field("02:00", min_length=5, max_length=5)
    target_dir: str = Field("scheduled", min_length=1, max_length=255)


class BackupScheduleSettingsResponse(BaseModel):
    scope: str = "default"
    enabled: bool = False
    interval_days: int = 1
    run_time: str = "02:00"
    schedule_timezone: str = "UTC"
    target_dir: str = "scheduled"
    backup_export_root: str
    last_run_at: datetime | None = None
    last_status: str | None = None
    last_error: str | None = None
    last_output_dir: str | None = None
    updated_at: datetime | None = None
