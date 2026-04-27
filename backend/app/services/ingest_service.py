import hashlib
import mimetypes
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from sqlalchemy import Select, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import (
    Category,
    Document,
    DocumentCategory,
    DocumentFile,
    DocumentTag,
    DocumentVersion,
    File,
    IngestEvent,
    IngestJob,
    IngestState,
    ReviewStatus,
    RuleVersion,
    SourceType,
    Tag,
)
from app.services.caption_parser import parse_caption
from app.services.dedupe_service import find_by_checksum
from app.services.error_codes import (
    IngestErrorCode,
    IngestPipelineError,
    classify_exception_for_stage,
)
from app.services.rule_engine import RuleInput, apply_rules
from app.services.search_sync_service import enqueue_document_index_sync
from app.services.storage_disk import put_file_from_path as put_file_disk_from_path
from app.services.storage_minio import ensure_bucket, get_minio_client, put_file_from_path as put_file_minio_from_path
from app.services.summary_service import build_summary
from app.services.text_extract import extract_body_text


@dataclass
class StoreResult:
    file: File
    checksum_sha256: str
    mime_type: str
    size_bytes: int
    duplicate_suspect: bool


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _set_state(
    db: Session,
    job: IngestJob,
    to_state: IngestState,
    message: str,
    event_type: str = "STATE_TRANSITION",
    payload: dict | None = None,
) -> None:
    from_state = job.state
    job.state = to_state
    if to_state in {IngestState.FAILED, IngestState.PUBLISHED, IngestState.NEEDS_REVIEW}:
        job.finished_at = _now()

    event = IngestEvent(
        ingest_job_id=job.id,
        from_state=from_state,
        to_state=to_state,
        event_type=event_type,
        event_message=message,
        event_payload=payload or {},
    )
    db.add(event)
    db.add(job)
    db.commit()


def _add_event(
    db: Session,
    job: IngestJob,
    event_type: str,
    message: str,
    payload: dict | None = None,
) -> None:
    event = IngestEvent(
        ingest_job_id=job.id,
        from_state=job.state,
        to_state=job.state,
        event_type=event_type,
        event_message=message,
        event_payload=payload or {},
    )
    db.add(event)
    db.commit()


def _compute_checksum(path: Path) -> tuple[str, int]:
    checksum = hashlib.sha256()
    size_bytes = 0
    with path.open("rb") as fp:
        while True:
            chunk = fp.read(1024 * 1024)
            if not chunk:
                break
            checksum.update(chunk)
            size_bytes += len(chunk)
    return checksum.hexdigest(), size_bytes


def _storage_key(checksum: str, extension: str | None) -> str:
    ext = (extension or "bin").lower().lstrip(".")
    return f"{checksum[0:2]}/{checksum[2:4]}/{checksum}.{ext}"


def _store_file(db: Session, job: IngestJob) -> StoreResult:
    settings = get_settings()
    temp_path = Path(job.file_path_temp or "")
    if not temp_path.exists():
        raise FileNotFoundError(f"temp file not found: {temp_path}")

    checksum, size_bytes = _compute_checksum(temp_path)
    existing = find_by_checksum(db, checksum)
    filename = job.payload_json.get("filename") or temp_path.name
    mime_type, _ = mimetypes.guess_type(filename)
    mime_type = mime_type or "application/octet-stream"
    duplicate_suspect = False
    if existing:
        linked_count = db.execute(
            select(func.count(DocumentFile.id)).where(DocumentFile.file_id == existing.id)
        ).scalar_one()
        duplicate_suspect = linked_count > 0
        return StoreResult(
            file=existing,
            checksum_sha256=checksum,
            mime_type=mime_type,
            size_bytes=size_bytes,
            duplicate_suspect=duplicate_suspect,
        )

    extension = Path(filename).suffix.lstrip(".") or None
    storage_key = _storage_key(checksum, extension)

    if settings.storage_backend == "minio":
        client = get_minio_client(
            endpoint=settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )
        ensure_bucket(client, settings.storage_bucket)
        put_file_minio_from_path(client, settings.storage_bucket, storage_key, str(temp_path), mime_type)
    else:
        put_file_disk_from_path(settings.storage_disk_root, storage_key, str(temp_path))

    file_row = File(
        source=job.source,
        source_ref=job.source_ref,
        storage_backend=settings.storage_backend,
        bucket=settings.storage_bucket,
        storage_key=storage_key,
        original_filename=filename,
        uploaded_filename=filename,
        extension=extension,
        checksum_sha256=checksum,
        mime_type=mime_type,
        size_bytes=size_bytes,
        metadata_json={},
    )
    db.add(file_row)
    db.commit()
    db.refresh(file_row)

    return StoreResult(
        file=file_row,
        checksum_sha256=checksum,
        mime_type=mime_type,
        size_bytes=size_bytes,
        duplicate_suspect=False,
    )


def _get_active_rules(db: Session) -> dict:
    stmt: Select = (
        select(RuleVersion)
        .where(RuleVersion.is_active.is_(True))
        .order_by(RuleVersion.published_at.desc().nulls_last(), RuleVersion.created_at.desc())
        .limit(1)
    )
    rv = db.execute(stmt).scalar_one_or_none()
    return rv.rules_json if rv else {"default_category": "기타", "category_rules": []}


def _upsert_category(db: Session, category_name: str) -> Category | None:
    if not category_name:
        return None
    normalized = category_name.strip()
    if not normalized:
        return None

    slug = normalized.lower().replace(" ", "-")
    existing = db.execute(select(Category).where(Category.slug == slug)).scalar_one_or_none()
    if existing:
        return existing

    category = Category(name=normalized, slug=slug, is_active=True)
    db.add(category)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        category = db.execute(select(Category).where(Category.slug == slug)).scalar_one_or_none()
    if category:
        db.refresh(category)
    return category


def _upsert_tags(db: Session, names: list[str]) -> list[Tag]:
    tags: list[Tag] = []
    for raw in names:
        name = raw.strip()
        if not name:
            continue
        slug = name.lower().replace(" ", "-")
        tag = db.execute(select(Tag).where(Tag.slug == slug)).scalar_one_or_none()
        if not tag:
            tag = Tag(name=name, slug=slug)
            db.add(tag)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                tag = db.execute(select(Tag).where(Tag.slug == slug)).scalar_one_or_none()
        if tag:
            tags.append(tag)
    return tags


def _create_document(
    db: Session,
    job: IngestJob,
    file_row: File,
    title: str,
    description: str,
    caption_raw: str,
    summary: str,
    category_id,
    event_date,
    tags: list[str],
    review_reasons: list[str],
) -> Document:
    review_status = ReviewStatus.NEEDS_REVIEW if review_reasons else ReviewStatus.NONE

    doc = Document(
        source=job.source,
        source_ref=job.source_ref,
        title=title,
        description=description,
        caption_raw=caption_raw,
        summary=summary,
        category_id=category_id,
        event_date=event_date,
        ingested_at=job.received_at,
        review_status=review_status,
        review_reasons=review_reasons,
        current_version_no=1,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    display_filename = str(job.payload_json.get("filename") or file_row.original_filename or "").strip() or file_row.original_filename
    db.add(
        DocumentFile(
            document_id=doc.id,
            file_id=file_row.id,
            display_filename=display_filename,
            is_primary=True,
        )
    )
    if doc.category_id:
        db.add(DocumentCategory(document_id=doc.id, category_id=doc.category_id))

    tag_rows = _upsert_tags(db, tags)
    for tag in tag_rows:
        db.add(DocumentTag(document_id=doc.id, tag_id=tag.id))

    db.add(
        DocumentVersion(
            document_id=doc.id,
            version_no=1,
            title=doc.title,
            description=doc.description,
            summary=doc.summary,
            category_id=doc.category_id,
            event_date=doc.event_date,
            tags_snapshot=[tag.name for tag in tag_rows],
            change_reason="initial_ingest",
        )
    )
    db.execute(
        update(Document)
        .where(Document.id == doc.id)
        .values(
            search_vector=func.to_tsvector(
                "simple",
                func.concat_ws(" ", Document.title, Document.description, Document.summary, Document.caption_raw),
            )
        )
    )
    db.commit()
    return doc


def _fail_job(
    db: Session,
    job: IngestJob,
    doc: Document | None,
    error_code: str,
    error_stage: str,
    error_message: str,
) -> dict:
    job.last_error_code = error_code
    job.last_error_message = error_message
    db.add(job)
    db.commit()

    _set_state(
        db,
        job,
        IngestState.FAILED,
        f"ingest failed at {error_stage}",
        event_type="ERROR",
        payload={
            "error_code": error_code,
            "error_stage": error_stage,
            "error": error_message,
        },
    )

    return {
        "ok": False,
        "job_id": str(job.id),
        "reason": error_code,
        "error_code": error_code,
        "error_stage": error_stage,
        "error_message": error_message,
    }


def process_ingest_job(db: Session, job_id: UUID) -> dict:
    job = db.get(IngestJob, job_id)
    if not job:
        return {"ok": False, "reason": "job_not_found"}

    job.started_at = _now()
    job.attempt_count += 1
    job.retry_after = None
    db.add(job)
    db.commit()

    doc: Document | None = None

    try:
        try:
            store_result = _store_file(db, job)
        except Exception as exc:  # noqa: BLE001
            raise IngestPipelineError(
                code=classify_exception_for_stage(exc, "STORED"),
                stage="STORED",
                message=str(exc),
            ) from exc

        _set_state(
            db,
            job,
            IngestState.STORED,
            "file stored",
            payload={"checksum_sha256": store_result.checksum_sha256, "file_id": str(store_result.file.id)},
        )

        filename = job.payload_json.get("filename") or store_result.file.original_filename
        try:
            parsed = parse_caption(job.caption, filename)
        except Exception as exc:  # noqa: BLE001
            raise IngestPipelineError(
                code=classify_exception_for_stage(exc, "EXTRACTED"),
                stage="EXTRACTED",
                message=str(exc),
            ) from exc

        summary = ""
        try:
            summary = build_summary(parsed, filename=filename, mime_type=store_result.mime_type)
        except Exception as summary_error:  # noqa: BLE001
            _add_event(
                db,
                job,
                event_type="WARNING",
                message="summary generation failed; fallback to empty summary",
                payload={
                    "error_code": IngestErrorCode.SUMMARY_EXTRACT_FAIL,
                    "error": str(summary_error),
                },
            )

        body_text = ""
        try:
            body_text = extract_body_text(
                job.file_path_temp,
                mime_type=store_result.mime_type,
                filename=filename,
            )
        except Exception as extract_error:  # noqa: BLE001
            _add_event(
                db,
                job,
                event_type="WARNING",
                message="body text extraction failed; continuing without body signals",
                payload={"error": str(extract_error)[:500]},
            )

        _set_state(
            db,
            job,
            IngestState.EXTRACTED,
            "caption and metadata extracted",
            payload={"title": parsed.title, "body_chars": len(body_text)},
        )

        try:
            rules = _get_active_rules(db)
            rule_out = apply_rules(
                RuleInput(
                    caption=parsed,
                    title=parsed.title,
                    description=parsed.description,
                    filename=filename,
                    body_text=body_text,
                    metadata_date_text=None,
                    ingested_at=job.received_at,
                    mime_type=store_result.mime_type,
                ),
                rules,
            )
        except Exception as exc:  # noqa: BLE001
            raise IngestPipelineError(
                code=classify_exception_for_stage(exc, "CLASSIFIED"),
                stage="CLASSIFIED",
                message=str(exc),
            ) from exc

        review_reasons = list(rule_out.review_reasons)
        if store_result.duplicate_suspect and "DUPLICATE_SUSPECT" not in review_reasons:
            review_reasons.append("DUPLICATE_SUSPECT")

        category = _upsert_category(db, rule_out.category)

        _set_state(
            db,
            job,
            IngestState.CLASSIFIED,
            "classification completed",
            payload={
                "category": category.name if category else None,
                "event_date": rule_out.event_date.isoformat(),
                "tags": rule_out.tags,
                "review_reasons": review_reasons,
            },
        )

        try:
            doc = _create_document(
                db=db,
                job=job,
                file_row=store_result.file,
                title=parsed.title,
                description=parsed.description,
                caption_raw=parsed.caption_raw,
                summary=summary,
                category_id=category.id if category else None,
                event_date=rule_out.event_date,
                tags=rule_out.tags,
                review_reasons=review_reasons,
            )
        except Exception as exc:  # noqa: BLE001
            raise IngestPipelineError(
                code=classify_exception_for_stage(exc, "INDEXED"),
                stage="INDEXED",
                message=str(exc),
            ) from exc

        job.document_id = doc.id
        db.add(job)
        db.commit()

        _set_state(db, job, IngestState.INDEXED, "document indexed", payload={"document_id": str(doc.id)})
        enqueue_document_index_sync(doc.id)

        if review_reasons:
            _set_state(
                db,
                job,
                IngestState.NEEDS_REVIEW,
                "document requires review",
                payload={"review_reasons": review_reasons},
            )
        else:
            _set_state(db, job, IngestState.PUBLISHED, "document published")

        return {"ok": True, "job_id": str(job.id), "document_id": str(doc.id)}

    except IngestPipelineError as exc:
        return _fail_job(
            db=db,
            job=job,
            doc=doc,
            error_code=exc.code,
            error_stage=exc.stage,
            error_message=exc.message,
        )
    except Exception as exc:  # noqa: BLE001
        return _fail_job(
            db=db,
            job=job,
            doc=doc,
            error_code=IngestErrorCode.PIPELINE_UNEXPECTED,
            error_stage="PIPELINE",
            error_message=str(exc),
        )
