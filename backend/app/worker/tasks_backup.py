from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.config import get_settings
from app.db.models import AuditLog, BackupScheduleSetting
from app.db.session import SessionLocal
from app.services.backup_service import create_full_backup_and_copy
from app.worker.celery_app import celery_app


def _parse_run_time(value: str | None) -> tuple[int, int]:
    raw = (value or "02:00").strip()
    try:
        hh, mm = raw.split(":", maxsplit=1)
        hour = int(hh)
        minute = int(mm)
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError
        return hour, minute
    except Exception:
        return 2, 0


def _schedule_tz(settings) -> timezone | ZoneInfo:  # type: ignore[no-untyped-def]
    tz_name = (getattr(settings, "backup_schedule_timezone", "") or "").strip() or "UTC"
    try:
        return ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        return timezone.utc


def _is_due(row: BackupScheduleSetting, now_utc: datetime, *, schedule_tz: timezone | ZoneInfo = timezone.utc) -> tuple[bool, datetime]:
    hour, minute = _parse_run_time(row.run_time)
    interval_days = int(row.interval_days or 1)
    if interval_days < 1:
        interval_days = 1
    if interval_days > 60:
        interval_days = 60

    now_local = now_utc.astimezone(schedule_tz)

    if row.last_run_at is None:
        next_due_local = datetime.combine(now_local.date(), time(hour=hour, minute=minute, tzinfo=schedule_tz))
        next_due_utc = next_due_local.astimezone(timezone.utc)
        return now_utc >= next_due_utc, next_due_utc

    last_run_local = row.last_run_at.astimezone(schedule_tz)
    next_due_date = last_run_local.date() + timedelta(days=interval_days)
    next_due_local = datetime.combine(next_due_date, time(hour=hour, minute=minute, tzinfo=schedule_tz))
    next_due = next_due_local.astimezone(timezone.utc)
    return now_utc >= next_due, next_due


def _get_or_create_schedule(db) -> BackupScheduleSetting:  # type: ignore[no-untyped-def]
    row = db.get(BackupScheduleSetting, "default")
    if row:
        return row
    row = BackupScheduleSetting(
        scope="default",
        enabled=False,
        interval_days=1,
        run_time="02:00",
        target_dir="scheduled",
        created_by=None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@celery_app.task(bind=True)
def run_scheduled_full_backup_task(self):  # noqa: ANN201
    settings = get_settings()
    now_utc = datetime.now(tz=timezone.utc)
    schedule_tz = _schedule_tz(settings)
    with SessionLocal() as db:
        row = _get_or_create_schedule(db)
        if not row.enabled:
            return {"status": "skip", "reason": "disabled"}

        due, next_due = _is_due(row, now_utc, schedule_tz=schedule_tz)
        if not due:
            return {"status": "skip", "reason": "not_due", "next_due": next_due.isoformat()}

        try:
            out = create_full_backup_and_copy(settings, target_dir=row.target_dir or "scheduled")
            row.last_run_at = now_utc
            row.last_status = "SUCCESS"
            row.last_error = None
            row.last_output_dir = out.output_dir
            row.updated_at = now_utc
            db.add(row)
            db.add(
                AuditLog(
                    actor_user_id=None,
                    action="BACKUP_SCHEDULED_RUN",
                    target_type="backup_schedule",
                    after_json={
                        "status": "ok",
                        "output_dir": out.output_dir,
                        "items": out.items,
                    },
                )
            )
            db.commit()
            return {
                "status": "ok",
                "output_dir": out.output_dir,
                "items": out.items,
            }
        except Exception as exc:  # noqa: BLE001
            row.last_run_at = now_utc
            row.last_status = "FAILED"
            row.last_error = str(exc)[:2000]
            row.updated_at = now_utc
            db.add(row)
            db.add(
                AuditLog(
                    actor_user_id=None,
                    action="BACKUP_SCHEDULED_RUN_FAILED",
                    target_type="backup_schedule",
                    after_json={"status": "failed", "error": str(exc)},
                )
            )
            db.commit()
            return {"status": "failed", "error": str(exc)}
