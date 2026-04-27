import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, require_roles
from app.db.models import IngestEvent, IngestJob, IngestState, SourceType, UserRole
from app.db.session import get_db
from app.schemas.ingest import (
    IngestAcceptedResponse,
    IngestBatchAcceptedResponse,
    IngestBatchRejectedItem,
    IngestJobStatusResponse,
)
from app.worker.tasks_ingest import process_ingest_job_task

router = APIRouter()

_TMP_DIR = Path(tempfile.gettempdir()) / "doc-archive-ingest"
_TMP_DIR.mkdir(parents=True, exist_ok=True)
_MAX_BATCH_FILES = 50


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _save_upload_temp(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "upload.bin").suffix
    fd, temp_path_str = tempfile.mkstemp(prefix="ing_", suffix=suffix, dir=_TMP_DIR)
    temp_path = Path(temp_path_str)
    with os.fdopen(fd, "wb") as out_file:
        shutil.copyfileobj(upload.file, out_file)
    return temp_path


def _cleanup_temp_file(path_str: str) -> None:
    try:
        Path(path_str).unlink(missing_ok=True)
    except Exception:
        return


def _validate_batch_files(files: list[UploadFile]) -> None:
    if not files:
        raise HTTPException(status_code=400, detail="files is required")
    if len(files) > _MAX_BATCH_FILES:
        raise HTTPException(status_code=400, detail=f"too many files: max {_MAX_BATCH_FILES}")


def _build_batch_source_ref(prefix: str, index: int) -> str:
    return f"{prefix}:{index + 1}"


def _queue_ingest_job(
    db: Session,
    *,
    source: SourceType,
    source_ref: str | None,
    file_path_temp: str,
    caption: str | None,
    payload: dict[str, Any],
    created_by: UUID,
) -> tuple[IngestAcceptedResponse | None, str | None]:
    job = IngestJob(
        source=source,
        source_ref=source_ref,
        state=IngestState.RECEIVED,
        file_path_temp=file_path_temp,
        caption=caption,
        payload_json=payload,
        received_at=_now(),
        created_by=created_by,
    )
    db.add(job)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        _cleanup_temp_file(file_path_temp)
        return None, "duplicate source_ref"

    db.refresh(job)

    db.add(
        IngestEvent(
            ingest_job_id=job.id,
            from_state=None,
            to_state=IngestState.RECEIVED,
            event_type="STATE_TRANSITION",
            event_message="job received",
            event_payload=payload,
            created_by=created_by,
        )
    )
    db.commit()
    process_ingest_job_task.delay(str(job.id))

    return (
        IngestAcceptedResponse(
            job_id=job.id,
            state=job.state,
            source=job.source,
            source_ref=job.source_ref,
            queued_at=job.received_at,
        ),
        None,
    )


@router.get("/ingest/jobs/{job_id}", response_model=IngestJobStatusResponse)
def get_ingest_job_status(
    job_id: UUID,
    current_user: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> IngestJobStatusResponse:
    job = db.get(IngestJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="ingest job not found")

    if current_user.role != UserRole.ADMIN and job.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="forbidden")

    success_states = {IngestState.PUBLISHED, IngestState.NEEDS_REVIEW}
    terminal_states = {IngestState.PUBLISHED, IngestState.NEEDS_REVIEW, IngestState.FAILED}

    return IngestJobStatusResponse(
        job_id=job.id,
        state=job.state,
        source=job.source,
        source_ref=job.source_ref,
        document_id=job.document_id,
        attempt_count=job.attempt_count,
        max_attempts=job.max_attempts,
        last_error_code=job.last_error_code,
        last_error_message=job.last_error_message,
        received_at=job.received_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        is_terminal=job.state in terminal_states,
        success=job.state in success_states,
    )


@router.post("/ingest/manual", response_model=IngestAcceptedResponse, status_code=status.HTTP_202_ACCEPTED)
def ingest_manual(
    file: UploadFile = File(...),
    source: SourceType = Form(SourceType.manual),
    source_ref: str | None = Form(None),
    caption: str | None = Form(None),
    title: str | None = Form(None),
    description: str | None = Form(None),
    current_user: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> IngestAcceptedResponse:
    if source not in {SourceType.manual, SourceType.api}:
        raise HTTPException(status_code=400, detail="source must be manual or api")

    temp_path = _save_upload_temp(file)
    payload = {
        "filename": file.filename,
        "title": title,
        "description": description,
    }

    accepted, error = _queue_ingest_job(
        db,
        source=source,
        source_ref=source_ref,
        file_path_temp=str(temp_path),
        caption=caption,
        payload=payload,
        created_by=current_user.id,
    )
    if not accepted:
        raise HTTPException(status_code=409, detail=error or "ingest enqueue failed")
    return accepted


@router.post("/ingest/manual/batch", response_model=IngestBatchAcceptedResponse, status_code=status.HTTP_202_ACCEPTED)
def ingest_manual_batch(
    files: list[UploadFile] = File(...),
    source: SourceType = Form(SourceType.manual),
    source_ref_prefix: str | None = Form(None),
    caption: str | None = Form(None),
    title: str | None = Form(None),
    description: str | None = Form(None),
    current_user: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> IngestBatchAcceptedResponse:
    if source not in {SourceType.manual, SourceType.api}:
        raise HTTPException(status_code=400, detail="source must be manual or api")
    _validate_batch_files(files)

    prefix = source_ref_prefix.strip() if source_ref_prefix else None
    total_files = len(files)
    accepted_items: list[IngestAcceptedResponse] = []
    rejected_items: list[IngestBatchRejectedItem] = []

    for idx, upload in enumerate(files):
        temp_path = _save_upload_temp(upload)
        source_ref = _build_batch_source_ref(prefix, idx) if prefix else None
        payload = {
            "filename": upload.filename,
            "title": title,
            "description": description,
            "batch_index": idx + 1,
            "batch_total": total_files,
        }
        accepted, error = _queue_ingest_job(
            db,
            source=source,
            source_ref=source_ref,
            file_path_temp=str(temp_path),
            caption=caption,
            payload=payload,
            created_by=current_user.id,
        )
        if accepted:
            accepted_items.append(accepted)
            continue

        rejected_items.append(
            IngestBatchRejectedItem(
                index=idx + 1,
                filename=upload.filename or "upload.bin",
                source_ref=source_ref,
                error=error or "ingest enqueue failed",
            )
        )

    return IngestBatchAcceptedResponse(
        total_files=total_files,
        accepted_count=len(accepted_items),
        rejected_count=len(rejected_items),
        accepted=accepted_items,
        rejected=rejected_items,
    )
