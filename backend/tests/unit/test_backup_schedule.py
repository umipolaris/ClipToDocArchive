from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.core.config import Settings
from app.db.models import BackupScheduleSetting
from app.services.backup_service import resolve_backup_export_dir
from app.worker.tasks_backup import _is_due


def _row(*, interval_days: int, run_time: str, last_run_at: datetime | None) -> BackupScheduleSetting:
    return BackupScheduleSetting(
        scope="default",
        enabled=True,
        interval_days=interval_days,
        run_time=run_time,
        target_dir="scheduled",
        last_run_at=last_run_at,
    )


def test_is_due_initial_before_time():
    now = datetime(2026, 3, 6, 1, 59, tzinfo=timezone.utc)
    row = _row(interval_days=1, run_time="02:00", last_run_at=None)
    due, next_due = _is_due(row, now)
    assert due is False
    assert next_due.isoformat() == "2026-03-06T02:00:00+00:00"


def test_is_due_initial_after_time():
    now = datetime(2026, 3, 6, 2, 1, tzinfo=timezone.utc)
    row = _row(interval_days=1, run_time="02:00", last_run_at=None)
    due, next_due = _is_due(row, now)
    assert due is True
    assert next_due.isoformat() == "2026-03-06T02:00:00+00:00"


def test_is_due_with_interval_days():
    last_run = datetime(2026, 3, 3, 4, 30, tzinfo=timezone.utc)
    row = _row(interval_days=3, run_time="09:15", last_run_at=last_run)

    before_due = datetime(2026, 3, 6, 9, 14, tzinfo=timezone.utc)
    due_before, next_due = _is_due(row, before_due)
    assert due_before is False
    assert next_due.isoformat() == "2026-03-06T09:15:00+00:00"

    after_due = datetime(2026, 3, 6, 9, 16, tzinfo=timezone.utc)
    due_after, _ = _is_due(row, after_due)
    assert due_after is True


def test_is_due_uses_schedule_timezone():
    # 10:55 Asia/Seoul == 01:55 UTC
    now = datetime(2026, 3, 6, 1, 56, tzinfo=timezone.utc)
    row = _row(interval_days=1, run_time="10:55", last_run_at=None)
    due, next_due = _is_due(row, now, schedule_tz=ZoneInfo("Asia/Seoul"))
    assert due is True
    assert next_due.isoformat() == "2026-03-06T01:55:00+00:00"


def test_resolve_backup_export_dir_accepts_relative_parent_path(tmp_path: Path):
    settings = Settings(
        backup_root=str(tmp_path / "backup"),
        backup_export_root=str(tmp_path / "export"),
        backup_config_root=str(tmp_path / "config"),
        storage_disk_root=str(tmp_path / "archive"),
        database_url="postgresql+psycopg://archive:archive_pw@localhost:5432/archive",
    )
    out = resolve_backup_export_dir(settings, target_dir="../outside")
    assert out == (tmp_path / "outside").resolve()
    assert out.exists()


def test_resolve_backup_export_dir_accepts_relative(tmp_path: Path):
    settings = Settings(
        backup_root=str(tmp_path / "backup"),
        backup_export_root=str(tmp_path / "export"),
        backup_config_root=str(tmp_path / "config"),
        storage_disk_root=str(tmp_path / "archive"),
        database_url="postgresql+psycopg://archive:archive_pw@localhost:5432/archive",
    )
    out = resolve_backup_export_dir(settings, target_dir="nightly/amc")
    assert out == (tmp_path / "export" / "nightly" / "amc").resolve()
    assert out.exists()


def test_resolve_backup_export_dir_accepts_absolute(tmp_path: Path):
    settings = Settings(
        backup_root=str(tmp_path / "backup"),
        backup_export_root=str(tmp_path / "export"),
        backup_config_root=str(tmp_path / "config"),
        storage_disk_root=str(tmp_path / "archive"),
        database_url="postgresql+psycopg://archive:archive_pw@localhost:5432/archive",
    )
    absolute = tmp_path / "custom" / "exports"
    out = resolve_backup_export_dir(settings, target_dir=str(absolute))
    assert out == absolute.resolve()
    assert out.exists()


def test_resolve_backup_export_dir_rejects_file_path(tmp_path: Path):
    settings = Settings(
        backup_root=str(tmp_path / "backup"),
        backup_export_root=str(tmp_path / "export"),
        backup_config_root=str(tmp_path / "config"),
        storage_disk_root=str(tmp_path / "archive"),
        database_url="postgresql+psycopg://archive:archive_pw@localhost:5432/archive",
    )
    file_path = tmp_path / "not_a_dir.txt"
    file_path.write_text("x", encoding="utf-8")
    with pytest.raises(ValueError, match="directory"):
        resolve_backup_export_dir(settings, target_dir=str(file_path))
