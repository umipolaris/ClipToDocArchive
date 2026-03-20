from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, File as UploadFormFile, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, require_roles
from app.core.config import get_settings
from app.db.models import (
    AuditLog,
    BackupScheduleSetting,
    BrandingSetting,
    DashboardMilestone,
    Category,
    DashboardTask,
    DashboardTaskSetting,
    Document,
    DocumentCategory,
    DocumentComment,
    DocumentFile,
    DocumentTag,
    DocumentVersion,
    File as StoredFile,
    IngestEvent,
    IngestJob,
    RuleVersion,
    Ruleset,
    SavedFilter,
    SecurityPolicy,
    Tag,
    User,
    UserRole,
)
from app.db.session import get_db
from app.db.session import SessionLocal
from app.schemas.admin_backup import (
    BackupDeleteAllResponse,
    BackupDeleteResponse,
    BackupFilesResponse,
    BackupRestoreConfigRequest,
    BackupRestoreConfigResponse,
    BackupRestoreDbRequest,
    BackupRestoreDbResponse,
    BackupRestoreObjectsRequest,
    BackupRestoreObjectsResponse,
    BackupRunAllResponse,
    BackupRunResponse,
    BackupScheduleSettingsResponse,
    BackupScheduleSettingsUpdateRequest,
)
from app.services.backup_service import (
    BackupKind,
    ConfigRestoreMode,
    create_config_backup,
    create_full_backup_and_copy,
    create_db_backup,
    create_objects_backup,
    delete_backup_file,
    get_backup_file_path,
    list_backup_files,
    restore_config_backup,
    restore_db_backup,
    restore_objects_backup,
    resolve_backup_export_dir,
    promote_restored_db,
    store_uploaded_backup,
)

router = APIRouter()


@dataclass
class _PromoteUserSnapshot:
    id: UUID
    username: str
    password_hash: str
    role: UserRole
    is_active: bool
    password_changed_at: datetime | None


@dataclass
class _SessionUser:
    id: UUID
    username: str
    role: UserRole


def _snapshot_user_for_promote(db: Session, user_id: UUID) -> _PromoteUserSnapshot | None:
    row = db.get(User, user_id)
    if not row:
        return None
    return _PromoteUserSnapshot(
        id=row.id,
        username=row.username,
        password_hash=row.password_hash,
        role=row.role,
        is_active=bool(row.is_active),
        password_changed_at=row.password_changed_at,
    )


def _ensure_session_user_after_promote(snapshot: _PromoteUserSnapshot | None) -> _SessionUser | None:
    if snapshot is None:
        return None

    extra = SessionLocal()
    try:
        existing = extra.get(User, snapshot.id)
        if existing:
            return _SessionUser(id=existing.id, username=existing.username, role=existing.role)

        by_username = extra.execute(select(User).where(User.username == snapshot.username)).scalar_one_or_none()
        if by_username:
            return _SessionUser(id=by_username.id, username=by_username.username, role=by_username.role)

        seeded = User(
            id=snapshot.id,
            username=snapshot.username,
            password_hash=snapshot.password_hash,
            role=snapshot.role,
            is_active=snapshot.is_active,
            failed_login_attempts=0,
            locked_until=None,
            password_changed_at=snapshot.password_changed_at,
            created_by=None,
        )
        extra.add(seeded)
        extra.commit()
        return _SessionUser(id=seeded.id, username=seeded.username, role=seeded.role)
    except IntegrityError:
        extra.rollback()
        by_username = extra.execute(select(User).where(User.username == snapshot.username)).scalar_one_or_none()
        if by_username:
            return _SessionUser(id=by_username.id, username=by_username.username, role=by_username.role)
        return None
    finally:
        extra.close()


def _apply_session_user(request: Request, session_user: _SessionUser | None) -> None:
    if session_user is None:
        request.session.clear()
        return
    request.session["user_id"] = str(session_user.id)
    request.session["username"] = session_user.username
    request.session["role"] = session_user.role.value


def _write_backup_restore_audit(
    *,
    actor_user_id,
    action: str,
    payload: dict,
    db: Session,
    force_new_session: bool,
) -> None:
    if force_new_session:
        extra = SessionLocal()
        try:
            try:
                extra.add(
                    AuditLog(
                        actor_user_id=actor_user_id,
                        action=action,
                        target_type="backup_restore",
                        after_json=payload,
                    )
                )
                extra.commit()
            except IntegrityError:
                extra.rollback()
                extra.add(
                    AuditLog(
                        actor_user_id=None,
                        action=action,
                        target_type="backup_restore",
                        after_json=payload,
                    )
                )
                extra.commit()
        finally:
            extra.close()
        return

    try:
        db.add(
            AuditLog(
                actor_user_id=actor_user_id,
                action=action,
                target_type="backup_restore",
                after_json=payload,
            )
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        db.add(
            AuditLog(
                actor_user_id=None,
                action=action,
                target_type="backup_restore",
                after_json=payload,
            )
        )
        db.commit()


def _download_url(kind: BackupKind, filename: str) -> str:
    return f"/admin/backups/files/{kind}/{filename}/download"


def _create_backup_for_kind(kind: BackupKind) -> BackupRunResponse:
    settings = get_settings()
    if kind == "db":
        created = create_db_backup(settings)
    elif kind == "objects":
        created = create_objects_backup(settings)
    else:
        created = create_config_backup(settings)
    return BackupRunResponse(
        kind=created.kind,
        filename=created.filename,
        size_bytes=created.size_bytes,
        created_at=created.created_at,
        sha256=created.sha256,
    )


def _marker_count(db: Session, model) -> int:  # type: ignore[no-untyped-def]
    return int(db.execute(select(func.count()).select_from(model)).scalar_one() or 0)


def _marker_max_updated_at(db: Session, model) -> str:  # type: ignore[no-untyped-def]
    return str(db.execute(select(func.max(model.updated_at))).scalar_one() or "")


def _capture_consistency_marker(db: Session) -> dict[str, int | str | None]:
    tracked_models = [
        ("documents", Document, True),
        ("files", StoredFile, True),
        ("document_versions", DocumentVersion, True),
        ("document_files", DocumentFile, True),
        ("document_categories", DocumentCategory, True),
        ("document_tags", DocumentTag, True),
        ("document_comments", DocumentComment, True),
        ("dashboard_milestones", DashboardMilestone, True),
        ("dashboard_tasks", DashboardTask, True),
        ("dashboard_task_settings", DashboardTaskSetting, True),
        ("security_policies", SecurityPolicy, True),
        ("rulesets", Ruleset, True),
        ("rule_versions", RuleVersion, True),
        ("categories", Category, True),
        ("tags", Tag, True),
        ("saved_filters", SavedFilter, True),
        ("ingest_jobs", IngestJob, True),
        ("ingest_events", IngestEvent, True),
        ("branding_settings", BrandingSetting, True),
        ("backup_schedule_settings", BackupScheduleSetting, True),
    ]
    marker: dict[str, int | str | None] = {}
    for prefix, model, include_max_updated in tracked_models:
        marker[f"{prefix}_count"] = _marker_count(db, model)
        if include_max_updated:
            marker[f"{prefix}_max_updated_at"] = _marker_max_updated_at(db, model)
    return marker


def _safe_cleanup_artifacts(settings, artifacts: list[tuple[BackupKind, str]]) -> None:  # type: ignore[no-untyped-def]
    for kind, filename in artifacts:
        try:
            delete_backup_file(settings, kind, filename)
        except Exception:  # noqa: BLE001
            continue


def _cleanup_uploaded_artifact(settings, *, kind: BackupKind, filename: str) -> None:  # type: ignore[no-untyped-def]
    try:
        delete_backup_file(settings, kind, filename)
    except Exception:  # noqa: BLE001
        pass


def _normalize_run_time_text(value: str) -> str:
    raw = (value or "").strip()
    try:
        parsed = datetime.strptime(raw, "%H:%M")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="run_time must be HH:MM (24h)") from exc
    return parsed.strftime("%H:%M")


def _get_or_create_backup_schedule(db: Session, *, created_by: UUID | None) -> BackupScheduleSetting:
    row = db.get(BackupScheduleSetting, "default")
    if row:
        return row
    row = BackupScheduleSetting(
        scope="default",
        enabled=False,
        interval_days=1,
        run_time="02:00",
        target_dir="scheduled",
        created_by=created_by,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _to_backup_schedule_response(row: BackupScheduleSetting, *, settings) -> BackupScheduleSettingsResponse:  # type: ignore[no-untyped-def]
    return BackupScheduleSettingsResponse(
        scope=row.scope,
        enabled=bool(row.enabled),
        interval_days=int(row.interval_days or 1),
        run_time=row.run_time or "02:00",
        schedule_timezone=(settings.backup_schedule_timezone or "UTC"),
        target_dir=row.target_dir or "scheduled",
        backup_export_root=str(settings.backup_export_root),
        last_run_at=row.last_run_at,
        last_status=row.last_status,
        last_error=row.last_error,
        last_output_dir=row.last_output_dir,
        updated_at=row.updated_at,
    )


@router.get(
    "/admin/backups/files",
    response_model=BackupFilesResponse,
    dependencies=[Depends(require_roles(UserRole.ADMIN))],
)
def get_backup_files(
    kind: BackupKind = Query("db"),
):
    settings = get_settings()
    try:
        rows = list_backup_files(settings, kind, limit=200)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return BackupFilesResponse(
        kind=kind,
        items=[
            {
                "kind": row.kind,
                "filename": row.filename,
                "size_bytes": row.size_bytes,
                "created_at": row.created_at,
                "sha256": row.sha256,
                "download_url": _download_url(row.kind, row.filename),
            }
            for row in rows
        ],
    )


@router.get(
    "/admin/backups/files/{kind}/{filename}/download",
    dependencies=[Depends(require_roles(UserRole.ADMIN))],
)
def download_backup_file(
    kind: BackupKind,
    filename: str,
):
    settings = get_settings()
    try:
        path = get_backup_file_path(settings, kind, filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return FileResponse(path=str(path), media_type="application/octet-stream", filename=path.name)


@router.delete("/admin/backups/files/{kind}/{filename}", response_model=BackupDeleteResponse)
def remove_backup_file(
    kind: BackupKind,
    filename: str,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupDeleteResponse:
    settings = get_settings()
    try:
        deleted_name, meta_deleted = delete_backup_file(settings, kind, filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result = BackupDeleteResponse(
        status="deleted",
        kind=kind,
        filename=deleted_name,
        meta_deleted=meta_deleted,
    )
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="BACKUP_DELETE_FILE",
            target_type="backup",
            after_json=result.model_dump(mode="json"),
        )
    )
    db.commit()
    return result


@router.delete("/admin/backups/files", response_model=BackupDeleteAllResponse)
def remove_all_backup_files(
    confirm: bool = Query(False),
    kind: BackupKind | None = Query(None),
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupDeleteAllResponse:
    if not confirm:
        raise HTTPException(status_code=400, detail="confirm=true required")

    settings = get_settings()
    targets: list[BackupKind] = [kind] if kind else ["db", "objects", "config"]
    deleted_by_kind: dict[str, int] = {}
    meta_deleted_by_kind: dict[str, int] = {}
    errors: list[str] = []

    for target_kind in targets:
        deleted = 0
        meta_deleted = 0
        # Loop in batches so all files can be removed even when count > list limit.
        for _ in range(1000):
            try:
                rows = list_backup_files(settings, target_kind, limit=500)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{target_kind}: list failed: {exc}")
                break
            if not rows:
                break
            for row in rows:
                try:
                    _, meta_removed = delete_backup_file(settings, target_kind, row.filename)
                    deleted += 1
                    if meta_removed:
                        meta_deleted += 1
                except FileNotFoundError:
                    continue
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{target_kind}/{row.filename}: {exc}")
            if len(rows) < 500:
                break

        deleted_by_kind[target_kind] = deleted
        meta_deleted_by_kind[target_kind] = meta_deleted

    deleted_total = sum(deleted_by_kind.values())
    deleted_meta_total = sum(meta_deleted_by_kind.values())
    status = "ok" if not errors else "partial"
    result = BackupDeleteAllResponse(
        status=status,
        deleted_total=deleted_total,
        deleted_meta_total=deleted_meta_total,
        deleted_by_kind=deleted_by_kind,
        meta_deleted_by_kind=meta_deleted_by_kind,
        errors=errors[:100],
    )

    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="BACKUP_DELETE_ALL_FILES",
            target_type="backup",
            after_json=result.model_dump(mode="json"),
        )
    )
    db.commit()
    return result


@router.post("/admin/backups/run/{kind}", response_model=BackupRunResponse)
def run_backup(
    kind: BackupKind,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupRunResponse:
    try:
        result = _create_backup_for_kind(kind)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="BACKUP_RUN",
            target_type="backup",
            after_json=result.model_dump(mode="json"),
        )
    )
    db.commit()
    return result


@router.post("/admin/backups/run-all", response_model=BackupRunAllResponse)
def run_backup_all(
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupRunAllResponse:
    settings = get_settings()
    marker_before = _capture_consistency_marker(db)
    results: list[BackupRunResponse] = []
    created_artifacts: list[tuple[BackupKind, str]] = []

    for kind in ("db", "objects", "config"):
        try:
            created = _create_backup_for_kind(kind)  # type: ignore[arg-type]
            results.append(created)
            created_artifacts.append((created.kind, created.filename))
            marker_after = _capture_consistency_marker(db)
            if marker_after != marker_before:
                _safe_cleanup_artifacts(settings, created_artifacts)
                raise HTTPException(
                    status_code=409,
                    detail="backup consistency window violated: database changed during run-all; retry in low-traffic window",
                )
            marker_before = marker_after
            db.rollback()
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            _safe_cleanup_artifacts(settings, created_artifacts)
            raise HTTPException(status_code=500, detail=f"{kind} backup failed: {exc}") from exc

    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="BACKUP_RUN_ALL",
            target_type="backup",
            after_json={"items": [r.model_dump(mode="json") for r in results]},
        )
    )
    db.commit()
    return BackupRunAllResponse(items=results)


@router.get("/admin/backups/schedule", response_model=BackupScheduleSettingsResponse)
def get_backup_schedule_settings(
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupScheduleSettingsResponse:
    settings = get_settings()
    row = _get_or_create_backup_schedule(db, created_by=current_user.id)
    return _to_backup_schedule_response(row, settings=settings)


@router.post("/admin/backups/schedule", response_model=BackupScheduleSettingsResponse)
def upsert_backup_schedule_settings(
    req: BackupScheduleSettingsUpdateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupScheduleSettingsResponse:
    settings = get_settings()
    run_time = _normalize_run_time_text(req.run_time)
    if not (1 <= int(req.interval_days) <= 60):
        raise HTTPException(status_code=400, detail="interval_days must be between 1 and 60")

    target_dir = (req.target_dir or "").strip() or "scheduled"
    try:
        # Validate that the configured path can be resolved and created.
        resolve_backup_export_dir(settings, target_dir=target_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"target_dir validation failed: {exc}") from exc

    row = _get_or_create_backup_schedule(db, created_by=current_user.id)
    prev_enabled = bool(row.enabled)
    prev_interval_days = int(row.interval_days or 1)
    prev_run_time = row.run_time or "02:00"
    prev_target_dir = row.target_dir or "scheduled"

    row.enabled = bool(req.enabled)
    row.interval_days = int(req.interval_days)
    row.run_time = run_time
    row.target_dir = target_dir
    if (
        row.enabled
        and (
            prev_enabled != row.enabled
            or prev_interval_days != row.interval_days
            or prev_run_time != row.run_time
            or prev_target_dir != row.target_dir
        )
    ):
        # Restart schedule window when admin changes the schedule settings.
        row.last_run_at = None
        row.last_status = None
        row.last_error = None
        row.last_output_dir = None
    row.updated_at = datetime.now(tz=timezone.utc)
    db.add(row)
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="BACKUP_SCHEDULE_UPDATE",
            target_type="backup_schedule",
            after_json={
                "enabled": bool(row.enabled),
                "interval_days": row.interval_days,
                "run_time": row.run_time,
                "target_dir": row.target_dir,
                "backup_export_root": settings.backup_export_root,
            },
        )
    )
    db.commit()
    db.refresh(row)
    return _to_backup_schedule_response(row, settings=settings)


@router.post("/admin/backups/schedule/run-now", response_model=BackupRunAllResponse)
def run_backup_schedule_now(
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupRunAllResponse:
    settings = get_settings()
    row = _get_or_create_backup_schedule(db, created_by=current_user.id)
    try:
        out = create_full_backup_and_copy(settings, target_dir=row.target_dir or "scheduled")
    except Exception as exc:  # noqa: BLE001
        row.last_status = "FAILED"
        row.last_error = str(exc)
        row.updated_at = datetime.now(tz=timezone.utc)
        db.add(row)
        db.commit()
        raise HTTPException(status_code=500, detail=f"scheduled backup run failed: {exc}") from exc

    row.last_run_at = datetime.now(tz=timezone.utc)
    row.last_status = "SUCCESS"
    row.last_error = None
    row.last_output_dir = out.output_dir
    row.updated_at = datetime.now(tz=timezone.utc)
    db.add(row)
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="BACKUP_SCHEDULE_RUN_NOW",
            target_type="backup_schedule",
            after_json={"output_dir": out.output_dir, "items": out.items},
        )
    )
    db.commit()

    items = [
        BackupRunResponse(
            kind=item["kind"],  # type: ignore[arg-type]
            filename=str(item["filename"]),
            size_bytes=int(item["size_bytes"] or 0),
            created_at=datetime.now(tz=timezone.utc),
            sha256=(str(item["sha256"]) if item.get("sha256") else None),
        )
        for item in out.items
    ]
    return BackupRunAllResponse(items=items)


@router.post("/admin/backups/restore/db", response_model=BackupRestoreDbResponse)
def restore_backup_db(
    req: BackupRestoreDbRequest,
    request: Request,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupRestoreDbResponse:
    if not req.confirm:
        raise HTTPException(status_code=400, detail="confirm=true required")
    settings = get_settings()
    promote_snapshot = _snapshot_user_for_promote(db, current_user.id) if req.promote_to_active else None
    effective_actor_user_id = current_user.id
    promoted = False
    promoted_from: str | None = None
    try:
        restored_target = restore_db_backup(settings, filename=req.filename, target_db=req.target_db)
        if req.promote_to_active:
            db.close()
            promoted_from = restored_target
            restored_target = promote_restored_db(settings, source_db=restored_target)
            session_user = _ensure_session_user_after_promote(promote_snapshot)
            _apply_session_user(request, session_user)
            effective_actor_user_id = session_user.id if session_user else None
            promoted = True
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    result = BackupRestoreDbResponse(
        status="ok",
        filename=req.filename,
        target_db=restored_target,
        promoted=promoted,
        promoted_from=promoted_from,
    )
    _write_backup_restore_audit(
        actor_user_id=effective_actor_user_id,
        action="BACKUP_RESTORE_DB",
        payload=result.model_dump(mode="json"),
        db=db,
        force_new_session=promoted,
    )
    return result


@router.post("/admin/backups/upload-and-restore/db", response_model=BackupRestoreDbResponse)
async def upload_and_restore_backup_db(
    request: Request,
    file: UploadFile = UploadFormFile(...),
    target_db: str = Form("archive_restore"),
    confirm: bool = Form(False),
    promote_to_active: bool = Form(False),
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupRestoreDbResponse:
    if not confirm:
        raise HTTPException(status_code=400, detail="confirm=true required")
    settings = get_settings()
    promote_snapshot = _snapshot_user_for_promote(db, current_user.id) if promote_to_active else None
    effective_actor_user_id = current_user.id
    stored = None
    restored = False
    promoted = False
    promoted_from: str | None = None
    try:
        stored = store_uploaded_backup(
            settings,
            kind="db",
            upload_filename=file.filename,
            upload_stream=file.file,
        )
        restored_target = restore_db_backup(settings, filename=stored.filename, target_db=target_db)
        restored = True
        if promote_to_active:
            db.close()
            promoted_from = restored_target
            restored_target = promote_restored_db(settings, source_db=restored_target)
            session_user = _ensure_session_user_after_promote(promote_snapshot)
            _apply_session_user(request, session_user)
            effective_actor_user_id = session_user.id if session_user else None
            promoted = True
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        if stored and not restored:
            _cleanup_uploaded_artifact(settings, kind="db", filename=stored.filename)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        if stored and not restored:
            _cleanup_uploaded_artifact(settings, kind="db", filename=stored.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await file.close()

    result = BackupRestoreDbResponse(
        status="ok",
        filename=stored.filename,
        target_db=restored_target,
        promoted=promoted,
        promoted_from=promoted_from,
    )
    _write_backup_restore_audit(
        actor_user_id=effective_actor_user_id,
        action="BACKUP_UPLOAD_RESTORE_DB",
        payload=result.model_dump(mode="json"),
        db=db,
        force_new_session=promoted,
    )
    return result


@router.post("/admin/backups/restore/objects", response_model=BackupRestoreObjectsResponse)
def restore_backup_objects(
    req: BackupRestoreObjectsRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupRestoreObjectsResponse:
    if not req.confirm:
        raise HTTPException(status_code=400, detail="confirm=true required")
    try:
        restored_count = restore_objects_backup(
            get_settings(),
            filename=req.filename,
            replace_existing=req.replace_existing,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    result = BackupRestoreObjectsResponse(
        status="ok",
        filename=req.filename,
        restored_count=restored_count,
        replace_existing=req.replace_existing,
    )
    _write_backup_restore_audit(
        actor_user_id=current_user.id,
        action="BACKUP_RESTORE_OBJECTS",
        payload=result.model_dump(mode="json"),
        db=db,
        force_new_session=False,
    )
    return result


@router.post("/admin/backups/upload-and-restore/objects", response_model=BackupRestoreObjectsResponse)
async def upload_and_restore_backup_objects(
    file: UploadFile = UploadFormFile(...),
    replace_existing: bool = Form(True),
    confirm: bool = Form(False),
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupRestoreObjectsResponse:
    if not confirm:
        raise HTTPException(status_code=400, detail="confirm=true required")
    settings = get_settings()
    stored = None
    restored = False
    try:
        stored = store_uploaded_backup(
            settings,
            kind="objects",
            upload_filename=file.filename,
            upload_stream=file.file,
        )
        restored_count = restore_objects_backup(
            settings,
            filename=stored.filename,
            replace_existing=replace_existing,
        )
        restored = True
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        if stored and not restored:
            _cleanup_uploaded_artifact(settings, kind="objects", filename=stored.filename)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        if stored and not restored:
            _cleanup_uploaded_artifact(settings, kind="objects", filename=stored.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await file.close()

    result = BackupRestoreObjectsResponse(
        status="ok",
        filename=stored.filename,
        restored_count=restored_count,
        replace_existing=replace_existing,
    )
    _write_backup_restore_audit(
        actor_user_id=current_user.id,
        action="BACKUP_UPLOAD_RESTORE_OBJECTS",
        payload=result.model_dump(mode="json"),
        db=db,
        force_new_session=False,
    )
    return result


@router.post("/admin/backups/restore/config", response_model=BackupRestoreConfigResponse)
def restore_backup_config(
    req: BackupRestoreConfigRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupRestoreConfigResponse:
    if req.mode == "apply" and not req.confirm:
        raise HTTPException(status_code=400, detail="confirm=true required for apply mode")
    try:
        preview = restore_config_backup(get_settings(), filename=req.filename, mode=req.mode)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    result = BackupRestoreConfigResponse(
        status="ok",
        filename=req.filename,
        mode=req.mode,
        total_files=preview.total_files,
        files=preview.files,
    )
    _write_backup_restore_audit(
        actor_user_id=current_user.id,
        action="BACKUP_RESTORE_CONFIG",
        payload=result.model_dump(mode="json"),
        db=db,
        force_new_session=False,
    )
    return result


@router.post("/admin/backups/upload-and-restore/config", response_model=BackupRestoreConfigResponse)
async def upload_and_restore_backup_config(
    file: UploadFile = UploadFormFile(...),
    mode: ConfigRestoreMode = Form("preview"),
    confirm: bool = Form(False),
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackupRestoreConfigResponse:
    if mode == "apply" and not confirm:
        raise HTTPException(status_code=400, detail="confirm=true required for apply mode")

    settings = get_settings()
    stored = None
    restored = False
    try:
        stored = store_uploaded_backup(
            settings,
            kind="config",
            upload_filename=file.filename,
            upload_stream=file.file,
        )
        preview = restore_config_backup(settings, filename=stored.filename, mode=mode)
        restored = True
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        if stored and not restored:
            _cleanup_uploaded_artifact(settings, kind="config", filename=stored.filename)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        if stored and not restored:
            _cleanup_uploaded_artifact(settings, kind="config", filename=stored.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await file.close()

    result = BackupRestoreConfigResponse(
        status="ok",
        filename=stored.filename,
        mode=mode,
        total_files=preview.total_files,
        files=preview.files,
    )
    _write_backup_restore_audit(
        actor_user_id=current_user.id,
        action="BACKUP_UPLOAD_RESTORE_CONFIG",
        payload=result.model_dump(mode="json"),
        db=db,
        force_new_session=False,
    )
    return result
