import hashlib
import mimetypes
import os
import shutil
import tempfile
from difflib import unified_diff
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File as UploadFormFile, Form, HTTPException, Query, Request, UploadFile, status
from minio.error import S3Error
from sqlalchemy import and_, asc, desc, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased
from starlette.responses import FileResponse, StreamingResponse

from app.core.auth import CurrentUser, require_roles
from app.core.config import get_settings
from app.db.models import (
    AuditLog,
    Category,
    Document,
    DocumentCategory,
    DocumentComment,
    DocumentFile,
    DocumentTag,
    DocumentVersion,
    File as StoredFile,
    IngestJob,
    ReviewStatus,
    RuleVersion,
    SourceType,
    Tag,
    User,
    UserRole,
)
from app.db.session import SessionLocal, get_db
from app.schemas.document import (
    DocumentCommentCreateRequest,
    DocumentCommentDeleteResponse,
    DocumentCommentItem,
    DocumentCommentListResponse,
    DocumentCommentUpdateRequest,
    DocumentDeleteResponse,
    DocumentDetailResponse,
    DocumentHistoryItem,
    DocumentHistoryResponse,
    DocumentFileItem,
    DocumentListFileItem,
    DocumentListItem,
    DocumentListResponse,
    DocumentVersionDiffResponse,
    DocumentVersionSnapshotResponse,
    DocumentUpdateRequest,
    DocumentVersionItem,
    ManualPostCategoryOptionsResponse,
    ManualPostCreateRequest,
    ReclassifyRequest,
)
from app.services.dedupe_service import find_by_checksum
from app.services.meili_service import MeiliSearchError, is_meili_enabled, search_document_ids
from app.services.caption_parser import parse_caption
from app.services.rule_categories import extract_categories_from_rules_json
from app.services.rule_engine import RuleInput, apply_rules
from app.services.search_sync_service import enqueue_document_index_delete, enqueue_document_index_sync
from app.services.storage_disk import delete_file as delete_file_disk, put_file_from_path as put_file_disk_from_path
from app.services.storage_minio import (
    delete_file as delete_file_minio,
    ensure_bucket,
    get_minio_client,
    put_file_from_path as put_file_minio_from_path,
)
from app.services.summary_service import build_summary_from_document_fields

router = APIRouter()
_UPLOAD_TMP_DIR = Path(tempfile.gettempdir()) / "doc-archive-upload"
_UPLOAD_TMP_DIR.mkdir(parents=True, exist_ok=True)
_UPLOAD_CHUNK_SIZE = 1024 * 1024
_DOWNLOAD_CHUNK_SIZE = 1024 * 1024


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _slugify(text: str) -> str:
    return text.strip().lower().replace(" ", "-")


def _normalize_tag_names(names: list[str]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for raw in names:
        name = raw.strip()
        if not name:
            continue
        slug = _slugify(name)
        if slug in seen:
            continue
        seen.add(slug)
        normalized.append(name)
    return normalized


def _normalize_category_names(names: list[str]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for raw in names:
        name = raw.strip()
        if not name:
            continue
        slug = _slugify(name)
        if slug in seen:
            continue
        seen.add(slug)
        normalized.append(name)
    return normalized


def _get_active_rules(db: Session) -> dict:
    rv = (
        db.execute(
            select(RuleVersion)
            .where(RuleVersion.is_active.is_(True))
            .order_by(RuleVersion.published_at.desc().nulls_last(), RuleVersion.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    return rv.rules_json if rv else {"default_category": "기타", "category_rules": []}


def _build_manual_post_category_options(rule_categories: list[str], db_categories: list[str]) -> list[str]:
    return _normalize_category_names([*rule_categories, *db_categories])


def _storage_key(checksum: str, extension: str | None) -> str:
    ext = (extension or "bin").lower().lstrip(".")
    return f"{checksum[0:2]}/{checksum[2:4]}/{checksum}.{ext}"


def _file_download_path(file_id: UUID) -> str:
    return f"/files/{file_id}/download"


def _document_file_download_path(document_id: UUID, file_id: UUID) -> str:
    return f"/documents/{document_id}/files/{file_id}/download"


def _download_name(filename: str) -> str:
    normalized = Path(filename).name.strip()
    return normalized or "download.bin"


def _normalize_document_file_display_name(display_filename: str | None, fallback_filename: str) -> str:
    preferred = _download_name(display_filename or "")
    if preferred != "download.bin" or (display_filename or "").strip():
        return preferred
    return _download_name(fallback_filename)


def _content_disposition(filename: str) -> str:
    encoded = quote(_download_name(filename))
    return f"attachment; filename*=UTF-8''{encoded}"


def _parse_http_range(range_header: str | None, total_size: int) -> tuple[int, int] | None:
    if not range_header or total_size <= 0:
        return None
    value = range_header.strip().lower()
    if not value.startswith("bytes="):
        return None
    range_spec = value[6:]
    if "," in range_spec:
        raise HTTPException(status_code=416, detail="multiple ranges not supported")
    if "-" not in range_spec:
        return None
    start_text, end_text = range_spec.split("-", maxsplit=1)
    try:
        if start_text == "":
            suffix_len = int(end_text)
            if suffix_len <= 0:
                raise ValueError
            start = max(0, total_size - suffix_len)
            end = total_size - 1
        else:
            start = int(start_text)
            if start < 0:
                raise ValueError
            if end_text == "":
                end = total_size - 1
            else:
                end = int(end_text)
                if end < start:
                    raise ValueError
            end = min(end, total_size - 1)
        if start >= total_size:
            raise HTTPException(status_code=416, detail="range not satisfiable")
        return start, end
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=416, detail="invalid range header") from exc


def _iter_disk_file_range(path: Path, start: int, end: int, chunk_size: int):  # noqa: ANN202
    remaining = end - start + 1
    with path.open("rb") as fp:
        fp.seek(start)
        while remaining > 0:
            chunk = fp.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _get_tag_names(db: Session, document_id: UUID) -> list[str]:
    stmt = (
        select(Tag.name)
        .join(DocumentTag, DocumentTag.tag_id == Tag.id)
        .where(DocumentTag.document_id == document_id)
        .order_by(Tag.name.asc())
    )
    return list(db.execute(stmt).scalars().all())


def _get_document_category_names(db: Session, document_id: UUID) -> list[str]:
    rows = db.execute(
        select(Category.name)
        .join(DocumentCategory, DocumentCategory.category_id == Category.id)
        .where(DocumentCategory.document_id == document_id)
        .order_by(Category.name.asc())
    ).scalars().all()
    return [name for name in rows if name]


def _get_document_category_ids(db: Session, document_id: UUID) -> list[UUID]:
    rows = db.execute(
        select(DocumentCategory.category_id)
        .where(DocumentCategory.document_id == document_id)
        .order_by(DocumentCategory.created_at.asc())
    ).scalars().all()
    dedup: list[UUID] = []
    seen: set[UUID] = set()
    for category_id in rows:
        if category_id in seen:
            continue
        seen.add(category_id)
        dedup.append(category_id)
    return dedup


def _sync_document_categories(
    db: Session,
    *,
    document_id: UUID,
    category_ids: list[UUID],
    created_by: UUID,
) -> None:
    desired: list[UUID] = []
    seen: set[UUID] = set()
    for category_id in category_ids:
        if category_id in seen:
            continue
        seen.add(category_id)
        desired.append(category_id)

    existing_rows = db.execute(
        select(DocumentCategory).where(DocumentCategory.document_id == document_id)
    ).scalars().all()
    existing_map = {row.category_id: row for row in existing_rows}
    desired_set = set(desired)

    for row in existing_rows:
        if row.category_id not in desired_set:
            db.delete(row)

    for category_id in desired:
        if category_id in existing_map:
            continue
        db.add(
            DocumentCategory(
                document_id=document_id,
                category_id=category_id,
                created_by=created_by,
            )
        )
    db.flush()


def _get_document_files(db: Session, document_id: UUID) -> list[DocumentFileItem]:
    display_filename_expr = func.coalesce(DocumentFile.display_filename, StoredFile.original_filename)
    stmt = (
        select(DocumentFile, StoredFile, display_filename_expr.label("display_filename"))
        .join(DocumentFile, DocumentFile.file_id == StoredFile.id)
        .where(DocumentFile.document_id == document_id)
        .order_by(
            func.lower(display_filename_expr).asc(),
            display_filename_expr.asc(),
            StoredFile.id.asc(),
        )
    )
    rows = db.execute(stmt).all()
    return [
        DocumentFileItem(
            id=file_row.id,
            original_filename=_normalize_document_file_display_name(link.display_filename, display_name),
            mime_type=file_row.mime_type,
            size_bytes=file_row.size_bytes,
            checksum_sha256=file_row.checksum_sha256,
            storage_backend=file_row.storage_backend,
            download_path=_document_file_download_path(document_id, file_row.id),
        )
        for link, file_row, display_name in rows
    ]


def _get_document_file_previews(
    db: Session,
    document_ids: list[UUID],
    *,
    per_document_limit: int = 3,
) -> tuple[dict[UUID, int], dict[UUID, list[DocumentListFileItem]]]:
    if not document_ids:
        return {}, {}

    display_filename_expr = func.coalesce(DocumentFile.display_filename, StoredFile.original_filename)
    rows = db.execute(
        select(DocumentFile.document_id, StoredFile.id, display_filename_expr.label("display_filename"))
        .join(StoredFile, StoredFile.id == DocumentFile.file_id)
        .where(DocumentFile.document_id.in_(document_ids))
        .order_by(
            DocumentFile.document_id.asc(),
            func.lower(display_filename_expr).asc(),
            display_filename_expr.asc(),
            StoredFile.id.asc(),
        )
    ).all()

    counts: dict[UUID, int] = {}
    previews: dict[UUID, list[DocumentListFileItem]] = {}
    for document_id, file_id, display_name in rows:
        counts[document_id] = counts.get(document_id, 0) + 1
        items = previews.setdefault(document_id, [])
        if len(items) >= per_document_limit:
            continue
        items.append(
            DocumentListFileItem(
                id=file_id,
                original_filename=_normalize_document_file_display_name(display_name, ""),
                download_path=_document_file_download_path(document_id, file_id),
            )
        )

    return counts, previews


def _get_document_comment_counts(db: Session, document_ids: list[UUID]) -> dict[UUID, int]:
    if not document_ids:
        return {}
    rows = db.execute(
        select(DocumentComment.document_id, func.count(DocumentComment.id))
        .where(DocumentComment.document_id.in_(document_ids))
        .group_by(DocumentComment.document_id)
    ).all()
    return {document_id: int(comment_count) for document_id, comment_count in rows}


def _get_document_tags_map(db: Session, document_ids: list[UUID]) -> dict[UUID, list[str]]:
    if not document_ids:
        return {}

    rows = db.execute(
        select(DocumentTag.document_id, Tag.name)
        .join(Tag, Tag.id == DocumentTag.tag_id)
        .where(DocumentTag.document_id.in_(document_ids))
        .order_by(DocumentTag.document_id.asc(), Tag.name.asc())
    ).all()

    tags_map: dict[UUID, list[str]] = {}
    for document_id, tag_name in rows:
        tags_map.setdefault(document_id, []).append(tag_name)
    return tags_map


def _get_document_versions(db: Session, document_id: UUID) -> list[DocumentVersionItem]:
    rows = db.execute(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.version_no.desc())
        .limit(50)
    ).scalars().all()
    return [
        DocumentVersionItem(
            version_no=row.version_no,
            changed_at=row.changed_at,
            change_reason=row.change_reason,
            title=row.title,
            event_date=row.event_date,
        )
        for row in rows
    ]


def _normalize_comment_content(content: str | None) -> str:
    normalized = (content or "").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="content is required")
    if len(normalized) > 2000:
        raise HTTPException(status_code=400, detail="content must be <= 2000 chars")
    return normalized


def _to_document_comment_item(
    row: DocumentComment,
    *,
    actor_username: str | None,
    current_user: CurrentUser,
) -> DocumentCommentItem:
    is_owner = row.created_by == current_user.id if row.created_by else False
    can_manage = bool(is_owner or current_user.role == UserRole.ADMIN)
    is_edited = row.updated_at > row.created_at if row.updated_at and row.created_at else False
    return DocumentCommentItem(
        id=row.id,
        document_id=row.document_id,
        content=row.content,
        created_at=row.created_at,
        updated_at=row.updated_at,
        created_by=row.created_by,
        created_by_username=actor_username,
        is_edited=is_edited,
        can_edit=can_manage,
        can_delete=can_manage,
    )


def _get_document_comments(
    db: Session,
    *,
    document_id: UUID,
    current_user: CurrentUser,
) -> list[DocumentCommentItem]:
    rows = db.execute(
        select(DocumentComment, User.username.label("actor_username"))
        .outerjoin(User, User.id == DocumentComment.created_by)
        .where(DocumentComment.document_id == document_id)
        .order_by(DocumentComment.created_at.asc(), DocumentComment.id.asc())
    ).all()
    return [
        _to_document_comment_item(comment, actor_username=actor_username, current_user=current_user)
        for comment, actor_username in rows
    ]


def _get_document_version_row(db: Session, document_id: UUID, version_no: int) -> DocumentVersion | None:
    return db.execute(
        select(DocumentVersion)
        .where(
            and_(
                DocumentVersion.document_id == document_id,
                DocumentVersion.version_no == version_no,
            )
        )
        .limit(1)
    ).scalar_one_or_none()


def _make_unified_diff(from_text: str, to_text: str, *, from_label: str, to_label: str) -> str:
    from_lines = (from_text or "").splitlines()
    to_lines = (to_text or "").splitlines()
    lines = list(
        unified_diff(
            from_lines,
            to_lines,
            fromfile=from_label,
            tofile=to_label,
            lineterm="",
        )
    )
    if not lines:
        return "(no text diff)"
    return "\n".join(lines)


def _document_search_vector_expr():  # noqa: ANN202
    return func.coalesce(
        Document.search_vector,
        func.to_tsvector(
            "simple",
            func.concat_ws(" ", Document.title, Document.description, Document.summary, Document.caption_raw),
        ),
    )


def _refresh_document_search_vector(db: Session, document_id: UUID) -> None:
    db.execute(
        update(Document)
        .where(Document.id == document_id)
        .values(
            search_vector=func.to_tsvector(
                "simple",
                func.concat_ws(" ", Document.title, Document.description, Document.summary, Document.caption_raw),
            )
        )
    )
    db.flush()


def _last_modified_expr():  # noqa: ANN202
    latest_version_subquery = (
        select(func.max(DocumentVersion.changed_at))
        .where(DocumentVersion.document_id == Document.id)
        .correlate(Document)
        .scalar_subquery()
    )
    return func.coalesce(latest_version_subquery, Document.updated_at, Document.created_at, Document.ingested_at)


def _get_document_last_modified_map(db: Session, document_ids: list[UUID]) -> dict[UUID, datetime]:
    if not document_ids:
        return {}

    rows = db.execute(
        select(DocumentVersion.document_id, func.max(DocumentVersion.changed_at))
        .where(DocumentVersion.document_id.in_(document_ids))
        .group_by(DocumentVersion.document_id)
    ).all()
    return {document_id: changed_at for document_id, changed_at in rows if changed_at is not None}


def _build_order_by(
    *,
    sort_by: Literal["event_date", "ingested_at", "title", "created_at", "last_modified_at"],
    sort_order: Literal["asc", "desc"],
) -> list:
    primary = asc if sort_order == "asc" else desc
    secondary = asc if sort_order == "asc" else desc

    if sort_by == "title":
        return [primary(func.lower(Document.title)), secondary(Document.ingested_at)]
    if sort_by == "created_at":
        return [primary(Document.created_at), secondary(Document.ingested_at)]
    if sort_by == "ingested_at":
        return [primary(Document.ingested_at)]
    if sort_by == "last_modified_at":
        return [primary(_last_modified_expr()), secondary(Document.ingested_at)]
    return [primary(Document.event_date).nullslast(), secondary(Document.ingested_at)]


def _to_document_detail_response(db: Session, doc: Document) -> DocumentDetailResponse:
    tags = _get_tag_names(db, doc.id)
    category = db.get(Category, doc.category_id) if doc.category_id else None
    category_names = _get_document_category_names(db, doc.id)
    if category and category.name and category.name not in category_names:
        category_names = [category.name, *category_names]
    elif category and category.name:
        category_names = [category.name, *[name for name in category_names if name != category.name]]
    files = _get_document_files(db, doc.id)
    versions = _get_document_versions(db, doc.id)

    return DocumentDetailResponse(
        id=doc.id,
        source=doc.source.value,
        source_ref=doc.source_ref,
        title=doc.title,
        description=doc.description,
        caption_raw=doc.caption_raw,
        summary=doc.summary,
        category_id=doc.category_id,
        category=category.name if category else None,
        categories=category_names,
        event_date=doc.event_date,
        ingested_at=doc.ingested_at,
        is_pinned=bool(doc.is_pinned),
        pinned_at=doc.pinned_at,
        review_status=doc.review_status,
        review_reasons=doc.review_reasons,
        current_version_no=doc.current_version_no,
        tags=tags,
        files=files,
        versions=versions,
    )


def _upsert_category(db: Session, category_name: str, created_by: UUID) -> Category:
    normalized = category_name.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="category_name is empty")
    slug = _slugify(normalized)
    existing = db.execute(select(Category).where(Category.slug == slug)).scalar_one_or_none()
    if existing:
        return existing

    category = Category(name=normalized, slug=slug, is_active=True, created_by=created_by)
    db.add(category)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        recovered = db.execute(select(Category).where(Category.slug == slug)).scalar_one_or_none()
        if recovered:
            return recovered
        raise HTTPException(status_code=409, detail="failed to create category") from exc
    return category


def _upsert_tags(db: Session, names: list[str], created_by: UUID) -> list[Tag]:
    seen: set[str] = set()
    rows: list[Tag] = []
    for raw in names:
        name = raw.strip()
        if not name:
            continue
        slug = _slugify(name)
        if slug in seen:
            continue
        seen.add(slug)
        tag = db.execute(select(Tag).where(Tag.slug == slug)).scalar_one_or_none()
        if not tag:
            tag = Tag(name=name, slug=slug, created_by=created_by)
            db.add(tag)
            db.flush()
        rows.append(tag)
    return rows


def _append_document_version(
    db: Session,
    doc: Document,
    *,
    change_reason: str,
    tags_snapshot: list[str],
    created_by: UUID,
) -> None:
    doc.current_version_no += 1
    db.add(doc)
    db.add(
        DocumentVersion(
            document_id=doc.id,
            version_no=doc.current_version_no,
            title=doc.title,
            description=doc.description,
            summary=doc.summary,
            category_id=doc.category_id,
            event_date=doc.event_date,
            tags_snapshot=tags_snapshot,
            change_reason=change_reason,
            created_by=created_by,
        )
    )


def _finalize_minio_upload(*, file_id: UUID, tmp_path: str, storage_key: str, mime_type: str) -> None:
    settings = get_settings()
    try:
        client = get_minio_client(
            endpoint=settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )
        ensure_bucket(client, settings.storage_bucket)
        put_file_minio_from_path(client, settings.storage_bucket, storage_key, tmp_path, mime_type)
        with SessionLocal() as db:
            row = db.get(StoredFile, file_id)
            if row:
                row.storage_state = "stored"
                row.metadata_json = {}
                db.commit()
        Path(tmp_path).unlink(missing_ok=True)
    except Exception as exc:  # noqa: BLE001
        with SessionLocal() as db:
            row = db.get(StoredFile, file_id)
            if row:
                row.storage_state = "failed"
                row.metadata_json = {
                    "temp_path": tmp_path,
                    "error": str(exc)[:500],
                }
                db.commit()


def _store_uploaded_file(
    db: Session,
    *,
    source: SourceType,
    source_ref: str | None,
    upload: UploadFile,
    created_by: UUID,
    background_tasks: BackgroundTasks | None = None,
) -> StoredFile:
    filename = upload.filename or "upload.bin"
    suffix = Path(filename).suffix
    fd, tmp_path_raw = tempfile.mkstemp(prefix="doc_upload_", suffix=suffix, dir=_UPLOAD_TMP_DIR)
    tmp_path = Path(tmp_path_raw)
    checksum_sha256 = hashlib.sha256()
    size_bytes = 0
    cleanup_tmp = True
    try:
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = upload.file.read(_UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                checksum_sha256.update(chunk)
                size_bytes += len(chunk)
                out.write(chunk)

        checksum = checksum_sha256.hexdigest()
        existing = find_by_checksum(db, checksum)
        if existing:
            return existing

        mime_type, _ = mimetypes.guess_type(filename)
        mime_type = mime_type or "application/octet-stream"
        extension = Path(filename).suffix.lstrip(".") or None
        storage_key = _storage_key(checksum, extension)
        settings = get_settings()

        defer_minio = settings.storage_backend == "minio" and background_tasks is not None

        if defer_minio:
            storage_state = "pending"
            metadata: dict = {"temp_path": str(tmp_path)}
        else:
            storage_state = "stored"
            metadata = {}
            if settings.storage_backend == "minio":
                client = get_minio_client(
                    endpoint=settings.minio_endpoint,
                    access_key=settings.minio_access_key,
                    secret_key=settings.minio_secret_key,
                    secure=settings.minio_secure,
                )
                ensure_bucket(client, settings.storage_bucket)
                put_file_minio_from_path(client, settings.storage_bucket, storage_key, str(tmp_path), mime_type)
            else:
                put_file_disk_from_path(settings.storage_disk_root, storage_key, str(tmp_path))

        row = StoredFile(
            source=source,
            source_ref=source_ref,
            storage_backend=settings.storage_backend,
            bucket=settings.storage_bucket,
            storage_key=storage_key,
            storage_state=storage_state,
            original_filename=filename,
            uploaded_filename=filename,
            extension=extension,
            checksum_sha256=checksum,
            mime_type=mime_type,
            size_bytes=size_bytes,
            metadata_json=metadata,
            created_by=created_by,
        )
        db.add(row)
        db.flush()

        if defer_minio:
            cleanup_tmp = False
            background_tasks.add_task(
                _finalize_minio_upload,
                file_id=row.id,
                tmp_path=str(tmp_path),
                storage_key=storage_key,
                mime_type=mime_type,
            )

        return row
    finally:
        if cleanup_tmp:
            tmp_path.unlink(missing_ok=True)


def _delete_stored_object(file_row: StoredFile) -> None:
    settings = get_settings()
    temp_path_str = (file_row.metadata_json or {}).get("temp_path") if file_row.metadata_json else None
    if temp_path_str:
        Path(temp_path_str).unlink(missing_ok=True)
    storage_state = getattr(file_row, "storage_state", "stored") or "stored"
    if storage_state == "pending":
        return
    if file_row.storage_backend == "minio":
        client = get_minio_client(
            endpoint=settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )
        delete_file_minio(client, file_row.bucket, file_row.storage_key)
        return
    delete_file_disk(settings.storage_disk_root, file_row.storage_key)


def _cleanup_orphan_file(db: Session, file_row: StoredFile | None) -> bool:
    if not file_row:
        return False
    linked_count = db.execute(
        select(func.count()).select_from(DocumentFile).where(DocumentFile.file_id == file_row.id)
    ).scalar_one()
    if linked_count > 0:
        return False
    _delete_stored_object(file_row)
    db.delete(file_row)
    db.flush()
    return True


def _get_document_file_link(db: Session, document_id: UUID, file_id: UUID) -> DocumentFile | None:
    return db.execute(
        select(DocumentFile).where(
            and_(
                DocumentFile.document_id == document_id,
                DocumentFile.file_id == file_id,
            )
        )
    ).scalar_one_or_none()


def _build_file_download_response(
    *,
    file_row: StoredFile,
    request: Request,
    download_name: str,
):
    settings = get_settings()
    total_size = int(file_row.size_bytes or 0)
    range_value = _parse_http_range(request.headers.get("range"), total_size)
    headers = {
        "Content-Disposition": _content_disposition(download_name),
        "Accept-Ranges": "bytes",
        "Content-Length": str(total_size),
    }
    status_code = 200
    range_start = 0
    range_end = max(0, total_size - 1)
    if range_value:
        range_start, range_end = range_value
        content_length = range_end - range_start + 1
        headers["Content-Range"] = f"bytes {range_start}-{range_end}/{total_size}"
        headers["Content-Length"] = str(content_length)
        status_code = 206

    storage_state = getattr(file_row, "storage_state", "stored") or "stored"
    if storage_state != "stored":
        temp_path_str = (file_row.metadata_json or {}).get("temp_path") if file_row.metadata_json else None
        temp_path = Path(temp_path_str) if temp_path_str else None
        if not temp_path or not temp_path.exists():
            raise HTTPException(
                status_code=409 if storage_state == "pending" else 404,
                detail="file upload still in progress" if storage_state == "pending" else "file upload failed",
            )
        if range_value:
            return StreamingResponse(
                _iter_disk_file_range(temp_path, range_start, range_end, _DOWNLOAD_CHUNK_SIZE),
                media_type=file_row.mime_type,
                headers=headers,
                status_code=status_code,
            )
        return FileResponse(
            path=str(temp_path),
            media_type=file_row.mime_type,
            filename=_download_name(download_name),
            headers=headers,
        )

    if file_row.storage_backend == "minio":
        client = get_minio_client(
            endpoint=settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )
        try:
            if range_value:
                minio_resp = client.get_object(
                    bucket_name=file_row.bucket,
                    object_name=file_row.storage_key,
                    offset=range_start,
                    length=range_end - range_start + 1,
                )
            else:
                minio_resp = client.get_object(bucket_name=file_row.bucket, object_name=file_row.storage_key)
        except S3Error as exc:
            if exc.code in {"NoSuchKey", "NoSuchObject", "NoSuchBucket"}:
                raise HTTPException(status_code=404, detail="file object not found") from exc
            raise

        def stream_chunks():  # noqa: ANN202
            try:
                for chunk in minio_resp.stream(_DOWNLOAD_CHUNK_SIZE):
                    if chunk:
                        yield chunk
            finally:
                minio_resp.close()
                minio_resp.release_conn()

        return StreamingResponse(
            stream_chunks(),
            media_type=file_row.mime_type,
            headers=headers,
            status_code=status_code,
        )

    disk_path = Path(settings.storage_disk_root) / file_row.storage_key
    if not disk_path.exists():
        raise HTTPException(status_code=404, detail="file object not found")
    if range_value:
        return StreamingResponse(
            _iter_disk_file_range(disk_path, range_start, range_end, _DOWNLOAD_CHUNK_SIZE),
            media_type=file_row.mime_type,
            headers=headers,
            status_code=status_code,
        )
    return FileResponse(
        path=str(disk_path),
        media_type=file_row.mime_type,
        filename=_download_name(download_name),
        headers=headers,
    )


@router.get("/documents", response_model=DocumentListResponse)
def list_documents(
    q: str | None = Query(None),
    category_id: UUID | None = Query(None),
    category_name: str | None = Query(None),
    tag: str | None = Query(None),
    event_date_from: date | None = Query(None),
    event_date_to: date | None = Query(None),
    review_status: ReviewStatus | None = Query(None),
    sort_by: Literal["event_date", "ingested_at", "title", "created_at", "last_modified_at"] = Query("event_date"),
    sort_order: Literal["asc", "desc"] = Query("desc"),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentListResponse:
    order_by = _build_order_by(sort_by=sort_by, sort_order=sort_order)
    settings = get_settings()
    # NOTE:
    # Meilisearch index currently stores only primary category metadata.
    # When category filters are provided, force DB query path so multi-category
    # mapped documents are included correctly.
    if q and sort_by != "last_modified_at" and is_meili_enabled(settings) and category_id is None and category_name is None:
        try:
            meili_result = search_document_ids(
                q,
                page=page,
                size=size,
                category_id=category_id,
                category_name=category_name,
                tag_slug=tag,
                event_date_from=event_date_from,
                event_date_to=event_date_to,
                review_status=review_status,
                sort_by=sort_by,
                sort_order=sort_order,
                settings=settings,
            )
            total = meili_result.total
            doc_ids = meili_result.ids
            if not doc_ids:
                return DocumentListResponse(items=[], page=page, size=size, total=total)

            rows = db.execute(
                select(Document, Category.name.label("category_name"))
                .outerjoin(Category, Category.id == Document.category_id)
                .where(Document.id.in_(doc_ids))
                .order_by(*order_by)
            ).all()
            docs = [row[0] for row in rows]
            category_names = {row[0].id: row.category_name for row in rows}

            loaded_doc_ids = [doc.id for doc in docs]
            file_counts, file_previews = _get_document_file_previews(db, loaded_doc_ids)
            comment_counts = _get_document_comment_counts(db, loaded_doc_ids)
            tags_map = _get_document_tags_map(db, loaded_doc_ids)
            last_modified_map = _get_document_last_modified_map(db, loaded_doc_ids)

            items: list[DocumentListItem] = []
            for doc in docs:
                items.append(
                    DocumentListItem(
                        id=doc.id,
                        title=doc.title,
                        description=doc.description,
                        category=category_names.get(doc.id),
                        event_date=doc.event_date,
                        ingested_at=doc.ingested_at,
                        is_pinned=bool(doc.is_pinned),
                        pinned_at=doc.pinned_at,
                        last_modified_at=last_modified_map.get(doc.id, doc.updated_at or doc.created_at or doc.ingested_at),
                        tags=tags_map.get(doc.id, []),
                        file_count=file_counts.get(doc.id, 0),
                        comment_count=comment_counts.get(doc.id, 0),
                        files=file_previews.get(doc.id, []),
                        review_status=doc.review_status,
                        review_reasons=list(doc.review_reasons or []),
                    )
                )
            return DocumentListResponse(items=items, page=page, size=size, total=total)
        except MeiliSearchError:
            pass

    stmt = select(Document, Category.name.label("category_name")).outerjoin(Category, Category.id == Document.category_id)
    count_stmt = select(func.count(Document.id)).select_from(Document).outerjoin(Category, Category.id == Document.category_id)
    count_use_distinct = False

    filters = []
    ts_query = None
    if q:
        ts_query = func.plainto_tsquery("simple", q)
        filters.append(_document_search_vector_expr().op("@@")(ts_query))
    if category_id:
        category_id_match = (
            select(1)
            .select_from(DocumentCategory)
            .where(
                DocumentCategory.document_id == Document.id,
                DocumentCategory.category_id == category_id,
            )
            .exists()
        )
        filters.append(or_(Document.category_id == category_id, category_id_match))
    if category_name:
        if category_name == "미분류":
            has_any_category = (
                select(1)
                .select_from(DocumentCategory)
                .where(DocumentCategory.document_id == Document.id)
                .exists()
            )
            filters.append(~has_any_category)
        else:
            category_alias = aliased(Category)
            category_name_match = (
                select(1)
                .select_from(DocumentCategory)
                .join(category_alias, category_alias.id == DocumentCategory.category_id)
                .where(
                    DocumentCategory.document_id == Document.id,
                    category_alias.name == category_name,
                )
                .exists()
            )
            filters.append(or_(Category.name == category_name, category_name_match))
    if event_date_from:
        filters.append(Document.event_date >= event_date_from)
    if event_date_to:
        filters.append(Document.event_date <= event_date_to)
    if review_status:
        filters.append(Document.review_status == review_status)

    if tag:
        stmt = stmt.join(DocumentTag, DocumentTag.document_id == Document.id).join(Tag, Tag.id == DocumentTag.tag_id)
        count_stmt = count_stmt.join(DocumentTag, DocumentTag.document_id == Document.id).join(Tag, Tag.id == DocumentTag.tag_id)
        count_use_distinct = True
        filters.append(Tag.slug == tag)

    if filters:
        stmt = stmt.where(and_(*filters))
        count_stmt = count_stmt.where(and_(*filters))
    if count_use_distinct:
        count_stmt = count_stmt.with_only_columns(func.count(func.distinct(Document.id)))

    if q and ts_query is not None and sort_by == "event_date" and sort_order == "desc":
        rank = func.ts_rank_cd(_document_search_vector_expr(), ts_query)
        order_by_stmt = [desc(rank), *order_by]
    else:
        order_by_stmt = order_by

    total = db.execute(count_stmt).scalar_one()
    rows = db.execute(
        stmt.order_by(*order_by_stmt)
        .offset((page - 1) * size)
        .limit(size)
    ).all()
    docs = [row[0] for row in rows]
    category_names = {row[0].id: row.category_name for row in rows}
    doc_ids = [doc.id for doc in docs]
    file_counts, file_previews = _get_document_file_previews(db, doc_ids)
    comment_counts = _get_document_comment_counts(db, doc_ids)
    tags_map = _get_document_tags_map(db, doc_ids)
    last_modified_map = _get_document_last_modified_map(db, doc_ids)

    items: list[DocumentListItem] = []
    for doc in docs:
        items.append(
            DocumentListItem(
                id=doc.id,
                title=doc.title,
                description=doc.description,
                category=category_names.get(doc.id),
                event_date=doc.event_date,
                ingested_at=doc.ingested_at,
                is_pinned=bool(doc.is_pinned),
                pinned_at=doc.pinned_at,
                last_modified_at=last_modified_map.get(doc.id, doc.updated_at or doc.created_at or doc.ingested_at),
                tags=tags_map.get(doc.id, []),
                file_count=file_counts.get(doc.id, 0),
                comment_count=comment_counts.get(doc.id, 0),
                files=file_previews.get(doc.id, []),
                review_status=doc.review_status,
                review_reasons=list(doc.review_reasons or []),
            )
        )

    return DocumentListResponse(items=items, page=page, size=size, total=total)


@router.get("/documents/manual-post/category-options", response_model=ManualPostCategoryOptionsResponse)
def get_manual_post_category_options(
    _: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> ManualPostCategoryOptionsResponse:
    rule_categories = extract_categories_from_rules_json(_get_active_rules(db))
    db_categories = list(
        db.execute(select(Category.name).where(Category.is_active.is_(True)).order_by(Category.name.asc())).scalars().all()
    )
    categories = _build_manual_post_category_options(rule_categories, db_categories)
    return ManualPostCategoryOptionsResponse(categories=categories)


@router.post("/documents/manual-post", response_model=DocumentDetailResponse, status_code=status.HTTP_201_CREATED)
def create_manual_post(
    req: ManualPostCreateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentDetailResponse:
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    normalized_tags = _normalize_tag_names(req.tags)
    normalized_category_names = _normalize_category_names(req.category_names or [])

    category_id = req.category_id
    category_name_for_caption: str | None = None
    resolved_category_ids: list[UUID] = []
    if category_id:
        category = db.get(Category, category_id)
        if not category:
            raise HTTPException(status_code=400, detail="category_id not found")
        category_name_for_caption = category.name
        resolved_category_ids.append(category.id)
    if req.category_name and req.category_name.strip():
        category = _upsert_category(db, req.category_name, current_user.id)
        resolved_category_ids.append(category.id)
        if category_id is None:
            category_id = category.id
            category_name_for_caption = category.name

    for category_name in normalized_category_names:
        category = _upsert_category(db, category_name, current_user.id)
        resolved_category_ids.append(category.id)
        if category_id is None:
            category_id = category.id
            category_name_for_caption = category.name

    description = req.description or ""
    caption_raw = req.caption_raw
    if caption_raw is None:
        caption_lines = [title]
        if description:
            caption_lines.append(description)
        if category_name_for_caption:
            caption_lines.append(f"#분류:{category_name_for_caption}")
        if req.event_date:
            caption_lines.append(f"#날짜:{req.event_date.isoformat()}")
        if normalized_tags:
            caption_lines.append(f"#태그:{','.join(normalized_tags)}")
        caption_raw = "\n".join(caption_lines)

    ingested_at = _now()
    try:
        parsed_caption = parse_caption(caption_raw, "manual-post.txt")
        auto_rule_out = apply_rules(
            RuleInput(
                caption=parsed_caption,
                title=title,
                description=description,
                filename="manual-post.txt",
                body_text=description,
                metadata_date_text=req.event_date.isoformat() if req.event_date else None,
                ingested_at=ingested_at,
                mime_type="text/plain",
            ),
            _get_active_rules(db),
        )
        normalized_tags = _normalize_tag_names([*normalized_tags, *auto_rule_out.tags])
        if category_id is None and auto_rule_out.category and auto_rule_out.category.strip():
            inferred_category = _upsert_category(db, auto_rule_out.category, current_user.id)
            category_id = inferred_category.id
            category_name_for_caption = inferred_category.name
            resolved_category_ids.append(inferred_category.id)
    except Exception:
        # Smart tag/category generation is best-effort and must not block manual posting.
        pass

    dedup_category_ids: list[UUID] = []
    seen_category_ids: set[UUID] = set()
    for cid in resolved_category_ids:
        if cid in seen_category_ids:
            continue
        seen_category_ids.add(cid)
        dedup_category_ids.append(cid)
    if category_id and category_id not in seen_category_ids:
        dedup_category_ids.insert(0, category_id)
    if category_id:
        dedup_category_ids = [category_id, *[cid for cid in dedup_category_ids if cid != category_id]]

    summary = req.summary.strip() if req.summary else ""
    if not summary:
        summary = description[:400] if description else title[:400]

    doc = Document(
        source=SourceType.manual,
        source_ref=None,
        title=title,
        description=description,
        caption_raw=caption_raw,
        summary=summary,
        category_id=category_id,
        event_date=req.event_date,
        ingested_at=ingested_at,
        is_pinned=req.is_pinned,
        pinned_at=ingested_at if req.is_pinned else None,
        review_status=req.review_status,
        review_reasons=[],
        current_version_no=1,
        created_by=current_user.id,
    )
    db.add(doc)
    db.flush()
    _sync_document_categories(
        db,
        document_id=doc.id,
        category_ids=dedup_category_ids,
        created_by=current_user.id,
    )

    tag_rows = _upsert_tags(db, normalized_tags, current_user.id)
    for tag in tag_rows:
        db.add(DocumentTag(document_id=doc.id, tag_id=tag.id, created_by=current_user.id))

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
            change_reason="manual_post_create",
            created_by=current_user.id,
        )
    )
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="DOCUMENT_MANUAL_POST_CREATE",
            target_type="document",
            target_id=doc.id,
            source=doc.source,
            source_ref=doc.source_ref,
            after_json={
                "title": doc.title,
                "category_id": str(doc.category_id) if doc.category_id else None,
                "category_ids": [str(cid) for cid in _get_document_category_ids(db, doc.id)],
                "event_date": doc.event_date.isoformat() if doc.event_date else None,
                "is_pinned": bool(doc.is_pinned),
                "tags": [tag.name for tag in tag_rows],
            },
        )
    )
    _refresh_document_search_vector(db, doc.id)
    db.commit()
    db.refresh(doc)
    enqueue_document_index_sync(doc.id)
    return _to_document_detail_response(db, doc)


@router.get("/documents/{id}", response_model=DocumentDetailResponse)
def get_document(
    id: UUID,
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentDetailResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    return _to_document_detail_response(db, doc)


@router.get("/documents/{id}/comments", response_model=DocumentCommentListResponse)
def list_document_comments(
    id: UUID,
    current_user: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentCommentListResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    return DocumentCommentListResponse(
        items=_get_document_comments(db, document_id=doc.id, current_user=current_user)
    )


@router.post("/documents/{id}/comments", response_model=DocumentCommentItem, status_code=status.HTTP_201_CREATED)
def create_document_comment(
    id: UUID,
    req: DocumentCommentCreateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentCommentItem:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    content = _normalize_comment_content(req.content)
    comment = DocumentComment(
        document_id=doc.id,
        content=content,
        created_by=current_user.id,
    )
    db.add(comment)
    db.flush()
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="DOCUMENT_COMMENT_CREATE",
            target_type="document_comment",
            target_id=comment.id,
            after_json={
                "document_id": str(doc.id),
                "content": comment.content,
            },
        )
    )
    db.commit()
    db.refresh(comment)
    return _to_document_comment_item(comment, actor_username=current_user.username, current_user=current_user)


@router.patch("/documents/{id}/comments/{comment_id}", response_model=DocumentCommentItem)
def patch_document_comment(
    id: UUID,
    comment_id: UUID,
    req: DocumentCommentUpdateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentCommentItem:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    comment = db.execute(
        select(DocumentComment).where(
            and_(
                DocumentComment.id == comment_id,
                DocumentComment.document_id == doc.id,
            )
        )
    ).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="comment not found")

    is_owner = comment.created_by == current_user.id if comment.created_by else False
    if not is_owner and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="forbidden")

    content = _normalize_comment_content(req.content)
    before_content = comment.content
    comment.content = content
    comment.updated_at = _now()
    db.add(comment)
    db.flush()
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="DOCUMENT_COMMENT_UPDATE",
            target_type="document_comment",
            target_id=comment.id,
            before_json={
                "document_id": str(doc.id),
                "content": before_content,
            },
            after_json={
                "document_id": str(doc.id),
                "content": comment.content,
            },
        )
    )
    db.commit()
    db.refresh(comment)
    actor_name = (
        db.execute(select(User.username).where(User.id == comment.created_by)).scalar_one_or_none()
        if comment.created_by
        else None
    )
    return _to_document_comment_item(comment, actor_username=actor_name, current_user=current_user)


@router.delete("/documents/{id}/comments/{comment_id}", response_model=DocumentCommentDeleteResponse)
def delete_document_comment(
    id: UUID,
    comment_id: UUID,
    current_user: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentCommentDeleteResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    comment = db.execute(
        select(DocumentComment).where(
            and_(
                DocumentComment.id == comment_id,
                DocumentComment.document_id == doc.id,
            )
        )
    ).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="comment not found")

    is_owner = comment.created_by == current_user.id if comment.created_by else False
    if not is_owner and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="forbidden")

    before_json = {
        "document_id": str(doc.id),
        "content": comment.content,
        "created_by": str(comment.created_by) if comment.created_by else None,
    }
    db.delete(comment)
    db.flush()
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="DOCUMENT_COMMENT_DELETE",
            target_type="document_comment",
            target_id=comment_id,
            before_json=before_json,
        )
    )
    db.commit()
    return DocumentCommentDeleteResponse(
        status="deleted",
        document_id=doc.id,
        comment_id=comment_id,
    )


@router.get("/documents/{id}/history", response_model=DocumentHistoryResponse)
def get_document_history(
    id: UUID,
    page: int = Query(1, ge=1),
    size: int = Query(30, ge=1, le=200),
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentHistoryResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    base_filters = [AuditLog.target_type == "document", AuditLog.target_id == id]
    total = db.execute(select(func.count(AuditLog.id)).where(and_(*base_filters))).scalar_one()
    rows = db.execute(
        select(AuditLog, User.username.label("actor_username"))
        .outerjoin(User, User.id == AuditLog.actor_user_id)
        .where(and_(*base_filters))
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .offset((page - 1) * size)
        .limit(size)
    ).all()

    return DocumentHistoryResponse(
        items=[
            DocumentHistoryItem(
                id=row[0].id,
                action=row[0].action,
                actor_username=row.actor_username,
                source=row[0].source.value if row[0].source else None,
                source_ref=row[0].source_ref,
                created_at=row[0].created_at,
                before_json=row[0].before_json,
                after_json=row[0].after_json,
                masked_fields=list(row[0].masked_fields or []),
            )
            for row in rows
        ],
        page=page,
        size=size,
        total=total,
    )


@router.get("/documents/{id}/versions/diff", response_model=DocumentVersionDiffResponse)
def get_document_version_diff(
    id: UUID,
    from_version_no: int | None = Query(None, ge=1),
    to_version_no: int | None = Query(None, ge=1),
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentVersionDiffResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    target_to = to_version_no or doc.current_version_no
    target_from = from_version_no if from_version_no is not None else max(1, target_to - 1)
    if target_from > target_to:
        raise HTTPException(status_code=400, detail="from_version_no must be <= to_version_no")

    from_row = _get_document_version_row(db, doc.id, target_from)
    to_row = _get_document_version_row(db, doc.id, target_to)
    if not from_row or not to_row:
        raise HTTPException(status_code=404, detail="requested version not found")

    changed_fields: list[str] = []
    if from_row.title != to_row.title:
        changed_fields.append("title")
    if from_row.description != to_row.description:
        changed_fields.append("description")
    if from_row.summary != to_row.summary:
        changed_fields.append("summary")
    if from_row.event_date != to_row.event_date:
        changed_fields.append("event_date")
    if from_row.category_id != to_row.category_id:
        changed_fields.append("category_id")
    if sorted(from_row.tags_snapshot or []) != sorted(to_row.tags_snapshot or []):
        changed_fields.append("tags")

    description_diff = _make_unified_diff(
        from_row.description,
        to_row.description,
        from_label=f"v{from_row.version_no}:description",
        to_label=f"v{to_row.version_no}:description",
    )
    summary_diff = _make_unified_diff(
        from_row.summary,
        to_row.summary,
        from_label=f"v{from_row.version_no}:summary",
        to_label=f"v{to_row.version_no}:summary",
    )

    return DocumentVersionDiffResponse(
        document_id=doc.id,
        from_version_no=from_row.version_no,
        to_version_no=to_row.version_no,
        changed_fields=changed_fields,
        title_from=from_row.title,
        title_to=to_row.title,
        description_diff=description_diff,
        summary_diff=summary_diff,
        tags_from=list(from_row.tags_snapshot or []),
        tags_to=list(to_row.tags_snapshot or []),
        event_date_from=from_row.event_date,
        event_date_to=to_row.event_date,
        category_id_from=from_row.category_id,
        category_id_to=to_row.category_id,
    )


@router.get("/documents/{id}/versions/{version_no}/snapshot", response_model=DocumentVersionSnapshotResponse)
def get_document_version_snapshot(
    id: UUID,
    version_no: int,
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentVersionSnapshotResponse:
    if version_no < 1:
        raise HTTPException(status_code=400, detail="version_no must be >= 1")

    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    version_row = _get_document_version_row(db, doc.id, version_no)
    if not version_row:
        raise HTTPException(status_code=404, detail="requested version not found")

    category_name: str | None = None
    if version_row.category_id:
        category = db.get(Category, version_row.category_id)
        category_name = category.name if category else None

    tags = [str(tag).strip() for tag in (version_row.tags_snapshot or []) if str(tag).strip()]

    return DocumentVersionSnapshotResponse(
        document_id=doc.id,
        version_no=version_row.version_no,
        changed_at=version_row.changed_at,
        change_reason=version_row.change_reason,
        title=version_row.title,
        description=version_row.description,
        summary=version_row.summary,
        category_id=version_row.category_id,
        category=category_name,
        event_date=version_row.event_date,
        tags=tags,
    )


@router.get("/files/{file_id}/download")
def download_file(
    file_id: UUID,
    request: Request,
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
):
    file_row = db.get(StoredFile, file_id)
    if not file_row:
        raise HTTPException(status_code=404, detail="file not found")
    return _build_file_download_response(
        file_row=file_row,
        request=request,
        download_name=file_row.original_filename,
    )


@router.get("/documents/{id}/files/{file_id}/download")
def download_document_file(
    id: UUID,
    file_id: UUID,
    request: Request,
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
):
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    link = _get_document_file_link(db, doc.id, file_id)
    if not link:
        raise HTTPException(status_code=404, detail="file link not found for document")

    file_row = db.get(StoredFile, file_id)
    if not file_row:
        raise HTTPException(status_code=404, detail="file not found")

    return _build_file_download_response(
        file_row=file_row,
        request=request,
        download_name=_normalize_document_file_display_name(link.display_filename, file_row.original_filename),
    )


@router.patch("/documents/{id}", response_model=DocumentDetailResponse)
def patch_document(
    id: UUID,
    req: DocumentUpdateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentDetailResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    before = {
        "title": doc.title,
        "description": doc.description,
        "summary": doc.summary,
        "category_id": doc.category_id,
        "category_ids": [str(cid) for cid in _get_document_category_ids(db, doc.id)],
        "event_date": doc.event_date,
        "is_pinned": bool(doc.is_pinned),
        "pinned_at": doc.pinned_at,
        "review_status": doc.review_status,
    }

    fields_set = req.model_fields_set
    if "title" in fields_set:
        if req.title is None or not req.title.strip():
            raise HTTPException(status_code=400, detail="title cannot be empty")
        doc.title = req.title.strip()
    if "description" in fields_set:
        doc.description = req.description or ""
    if "summary" in fields_set:
        doc.summary = req.summary or ""
    elif "title" in fields_set or "description" in fields_set:
        doc.summary = build_summary_from_document_fields(doc.title, doc.description)
    if "event_date" in fields_set:
        doc.event_date = req.event_date
    if "is_pinned" in fields_set and req.is_pinned is not None:
        if req.is_pinned:
            doc.is_pinned = True
            if doc.pinned_at is None:
                doc.pinned_at = _now()
        else:
            doc.is_pinned = False
            doc.pinned_at = None
    if "review_status" in fields_set and req.review_status is not None:
        doc.review_status = req.review_status

    category_id_provided = "category_id" in fields_set
    category_name_provided = "category_name" in fields_set
    category_names_provided = "category_names" in fields_set
    existing_category_ids = _get_document_category_ids(db, doc.id)

    resolved_category_id: UUID | None = None
    if category_name_provided:
        if req.category_name and req.category_name.strip():
            resolved_category_id = _upsert_category(db, req.category_name, current_user.id).id
        else:
            resolved_category_id = None

    resolved_category_name_ids: list[UUID] | None = None
    if category_names_provided:
        resolved_category_name_ids = []
        for category_name in _normalize_category_names(req.category_names or []):
            category_row = _upsert_category(db, category_name, current_user.id)
            resolved_category_name_ids.append(category_row.id)

    next_primary_category_id = doc.category_id
    if category_id_provided:
        if req.category_id:
            category_row = db.get(Category, req.category_id)
            if not category_row:
                raise HTTPException(status_code=400, detail="category_id not found")
            next_primary_category_id = category_row.id
        elif category_name_provided:
            next_primary_category_id = resolved_category_id
        else:
            next_primary_category_id = None
    elif category_name_provided:
        next_primary_category_id = resolved_category_id

    any_category_update = category_id_provided or category_name_provided or category_names_provided
    if any_category_update:
        next_category_ids = list(existing_category_ids)
        if resolved_category_name_ids is not None:
            next_category_ids = list(resolved_category_name_ids)
        if next_primary_category_id:
            if next_primary_category_id in next_category_ids:
                next_category_ids = [next_primary_category_id, *[cid for cid in next_category_ids if cid != next_primary_category_id]]
            else:
                next_category_ids = [next_primary_category_id, *next_category_ids]

        if next_primary_category_id is None and next_category_ids:
            next_primary_category_id = next_category_ids[0]

        dedup_next_category_ids: list[UUID] = []
        seen_next_category_ids: set[UUID] = set()
        for cid in next_category_ids:
            if cid in seen_next_category_ids:
                continue
            seen_next_category_ids.add(cid)
            dedup_next_category_ids.append(cid)
        if next_primary_category_id and next_primary_category_id in dedup_next_category_ids:
            dedup_next_category_ids = [
                next_primary_category_id,
                *[cid for cid in dedup_next_category_ids if cid != next_primary_category_id],
            ]

        doc.category_id = next_primary_category_id
        _sync_document_categories(
            db,
            document_id=doc.id,
            category_ids=dedup_next_category_ids,
            created_by=current_user.id,
        )

    if "tags" in fields_set:
        db.query(DocumentTag).filter(DocumentTag.document_id == doc.id).delete()
        for tag in _upsert_tags(db, req.tags or [], current_user.id):
            db.add(DocumentTag(document_id=doc.id, tag_id=tag.id, created_by=current_user.id))

    tags_snapshot = (req.tags or []) if "tags" in fields_set else _get_tag_names(db, doc.id)
    _append_document_version(
        db,
        doc,
        change_reason="manual_update",
        tags_snapshot=tags_snapshot,
        created_by=current_user.id,
    )
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="DOCUMENT_UPDATE",
            target_type="document",
            target_id=doc.id,
            before_json={
                "title": before["title"],
                "description": before["description"],
                "summary": before["summary"],
                "category_id": str(before["category_id"]) if before["category_id"] else None,
                "category_ids": before["category_ids"],
                "event_date": before["event_date"].isoformat() if before["event_date"] else None,
                "is_pinned": before["is_pinned"],
                "pinned_at": before["pinned_at"].isoformat() if before["pinned_at"] else None,
                "review_status": before["review_status"].value,
            },
            after_json={
                "title": doc.title,
                "description": doc.description,
                "summary": doc.summary,
                "category_id": str(doc.category_id) if doc.category_id else None,
                "category_ids": [str(cid) for cid in _get_document_category_ids(db, doc.id)],
                "event_date": doc.event_date.isoformat() if doc.event_date else None,
                "is_pinned": bool(doc.is_pinned),
                "pinned_at": doc.pinned_at.isoformat() if doc.pinned_at else None,
                "review_status": doc.review_status.value,
                "tags": tags_snapshot,
            },
        )
    )
    _refresh_document_search_vector(db, doc.id)
    db.commit()
    db.refresh(doc)
    enqueue_document_index_sync(doc.id)

    return _to_document_detail_response(db, doc)


@router.delete("/documents/{id}", response_model=DocumentDeleteResponse)
def delete_document(
    id: UUID,
    current_user: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentDeleteResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    file_ids = list(
        db.execute(
            select(DocumentFile.file_id).where(DocumentFile.document_id == doc.id)
        ).scalars().all()
    )
    unique_file_ids = list(dict.fromkeys(file_ids))
    file_rows: list[StoredFile] = []
    if unique_file_ids:
        file_rows = list(
            db.execute(select(StoredFile).where(StoredFile.id.in_(unique_file_ids))).scalars().all()
        )

    before_json = {
        "title": doc.title,
        "category_id": str(doc.category_id) if doc.category_id else None,
        "event_date": doc.event_date.isoformat() if doc.event_date else None,
        "file_link_count": len(file_ids),
    }

    db.execute(
        update(IngestJob)
        .where(IngestJob.document_id == doc.id)
        .values(document_id=None)
    )
    db.delete(doc)
    db.flush()

    deleted_orphan_files = 0
    for file_row in file_rows:
        if _cleanup_orphan_file(db, file_row):
            deleted_orphan_files += 1

    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="DOCUMENT_DELETE",
            target_type="document",
            target_id=id,
            source=doc.source,
            source_ref=doc.source_ref,
            before_json=before_json,
            after_json={
                "deleted_file_links": len(file_ids),
                "deleted_orphan_files": deleted_orphan_files,
            },
        )
    )
    db.commit()
    enqueue_document_index_delete(id)

    return DocumentDeleteResponse(
        status="deleted",
        document_id=id,
        deleted_file_links=len(file_ids),
        deleted_orphan_files=deleted_orphan_files,
    )


@router.delete("/documents/{id}/files/{file_id}", response_model=DocumentDetailResponse)
def delete_document_file(
    id: UUID,
    file_id: UUID,
    current_user: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentDetailResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    link = db.execute(
        select(DocumentFile).where(
            and_(DocumentFile.document_id == doc.id, DocumentFile.file_id == file_id),
        )
    ).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="file link not found for document")

    file_row = db.get(StoredFile, file_id)
    db.delete(link)
    db.flush()
    _cleanup_orphan_file(db, file_row)

    tags_snapshot = _get_tag_names(db, doc.id)
    _append_document_version(
        db,
        doc,
        change_reason="manual_file_delete",
        tags_snapshot=tags_snapshot,
        created_by=current_user.id,
    )
    remaining_file_count = db.execute(
        select(func.count()).select_from(DocumentFile).where(DocumentFile.document_id == doc.id)
    ).scalar_one()
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="DOCUMENT_FILE_DELETE",
            target_type="document",
            target_id=doc.id,
            before_json={
                "file_id": str(file_id),
            },
            after_json={
                "remaining_file_count": remaining_file_count,
            },
        )
    )
    db.commit()
    db.refresh(doc)
    enqueue_document_index_sync(doc.id)
    return _to_document_detail_response(db, doc)


@router.post("/documents/{id}/files", response_model=DocumentDetailResponse)
def add_document_files(
    id: UUID,
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = UploadFormFile(...),
    change_reason: str = Form("manual_file_add"),
    current_user: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentDetailResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    if not files:
        raise HTTPException(status_code=400, detail="files is required")

    existing_links = db.execute(
        select(DocumentFile.file_id, DocumentFile.is_primary).where(DocumentFile.document_id == doc.id)
    ).all()
    linked_file_ids: set[UUID] = {row.file_id for row in existing_links}
    has_primary = any(bool(row.is_primary) for row in existing_links)
    before_file_count = len(linked_file_ids)

    added_file_ids: list[UUID] = []
    renamed_file_ids: list[UUID] = []
    skipped_duplicates = 0
    for upload in files:
        display_filename = _normalize_document_file_display_name(upload.filename, "upload.bin")
        stored = _store_uploaded_file(
            db,
            source=doc.source,
            source_ref=doc.source_ref,
            upload=upload,
            created_by=current_user.id,
            background_tasks=background_tasks,
        )
        if stored.id in linked_file_ids:
            existing_link = _get_document_file_link(db, doc.id, stored.id)
            if existing_link and existing_link.display_filename != display_filename:
                existing_link.display_filename = display_filename
                existing_link.updated_at = _now()
                db.add(existing_link)
                renamed_file_ids.append(stored.id)
            else:
                skipped_duplicates += 1
            continue

        db.add(
            DocumentFile(
                document_id=doc.id,
                file_id=stored.id,
                display_filename=display_filename,
                is_primary=not has_primary,
                created_by=current_user.id,
            )
        )
        linked_file_ids.add(stored.id)
        added_file_ids.append(stored.id)
        has_primary = True

    if added_file_ids or renamed_file_ids:
        tags_snapshot = _get_tag_names(db, doc.id)
        normalized_reason = change_reason.strip() or "manual_file_add"
        _append_document_version(
            db,
            doc,
            change_reason=normalized_reason,
            tags_snapshot=tags_snapshot,
            created_by=current_user.id,
        )
        db.add(
            AuditLog(
                actor_user_id=current_user.id,
                action="DOCUMENT_FILE_ADD",
                target_type="document",
                target_id=doc.id,
                before_json={
                    "file_count": before_file_count,
                },
                after_json={
                    "file_count": len(linked_file_ids),
                    "added_file_ids": [str(file_id) for file_id in added_file_ids],
                    "renamed_file_ids": [str(file_id) for file_id in renamed_file_ids],
                    "skipped_duplicates": skipped_duplicates,
                    "change_reason": normalized_reason,
                },
            )
        )
        db.commit()
        db.refresh(doc)
        enqueue_document_index_sync(doc.id)

    return _to_document_detail_response(db, doc)


@router.post("/documents/{id}/files/{file_id}/replace", response_model=DocumentDetailResponse)
def replace_document_file(
    id: UUID,
    file_id: UUID,
    background_tasks: BackgroundTasks,
    file: UploadFile = UploadFormFile(...),
    change_reason: str = Form("manual_file_replace"),
    current_user: CurrentUser = Depends(require_roles(UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DocumentDetailResponse:
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    link = db.execute(
        select(DocumentFile).where(
            and_(DocumentFile.document_id == doc.id, DocumentFile.file_id == file_id),
        )
    ).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="file link not found for document")

    old_file = db.get(StoredFile, file_id)
    new_file = _store_uploaded_file(
        db,
        source=doc.source,
        source_ref=doc.source_ref,
        upload=file,
        created_by=current_user.id,
        background_tasks=background_tasks,
    )
    new_display_filename = _normalize_document_file_display_name(file.filename, new_file.original_filename)

    if new_file.id == link.file_id:
        if link.display_filename != new_display_filename:
            link.display_filename = new_display_filename
            link.updated_at = _now()
            db.add(link)
            tags_snapshot = _get_tag_names(db, doc.id)
            normalized_reason = change_reason.strip() or "manual_file_replace"
            _append_document_version(
                db,
                doc,
                change_reason=normalized_reason,
                tags_snapshot=tags_snapshot,
                created_by=current_user.id,
            )
            db.add(
                AuditLog(
                    actor_user_id=current_user.id,
                    action="DOCUMENT_FILE_REPLACE",
                    target_type="document",
                    target_id=doc.id,
                    before_json={
                        "old_file_id": str(file_id),
                        "old_file_name": old_file.original_filename if old_file else None,
                    },
                    after_json={
                        "new_file_id": str(new_file.id),
                        "new_file_name": new_display_filename,
                        "change_reason": normalized_reason,
                    },
                )
            )
            db.commit()
            db.refresh(doc)
            enqueue_document_index_sync(doc.id)
        return _to_document_detail_response(db, doc)

    duplicate_link = db.execute(
        select(DocumentFile).where(
            and_(
                DocumentFile.document_id == doc.id,
                DocumentFile.file_id == new_file.id,
                DocumentFile.id != link.id,
            )
        )
    ).scalar_one_or_none()
    if duplicate_link:
        duplicate_link.display_filename = new_display_filename
        duplicate_link.updated_at = _now()
        db.add(duplicate_link)
        db.delete(link)
    else:
        link.file_id = new_file.id
        link.display_filename = new_display_filename
        link.updated_at = _now()
        db.add(link)
    db.flush()
    _cleanup_orphan_file(db, old_file)

    tags_snapshot = _get_tag_names(db, doc.id)
    normalized_reason = change_reason.strip() or "manual_file_replace"
    _append_document_version(
        db,
        doc,
        change_reason=normalized_reason,
        tags_snapshot=tags_snapshot,
        created_by=current_user.id,
    )
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="DOCUMENT_FILE_REPLACE",
            target_type="document",
            target_id=doc.id,
            before_json={
                "old_file_id": str(file_id),
                "old_file_name": old_file.original_filename if old_file else None,
            },
            after_json={
                "new_file_id": str(new_file.id),
                "new_file_name": new_file.original_filename,
                "change_reason": normalized_reason,
            },
        )
    )
    db.commit()
    db.refresh(doc)
    enqueue_document_index_sync(doc.id)
    return _to_document_detail_response(db, doc)


@router.post("/documents/{id}/reclassify")
def reclassify_document(
    id: UUID,
    req: ReclassifyRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
):
    doc = db.get(Document, id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="DOCUMENT_RECLASSIFY_REQUEST",
            target_type="document",
            target_id=doc.id,
            after_json={
                "rule_version_id": str(req.rule_version_id),
                "dry_run": req.dry_run,
            },
        )
    )
    db.commit()

    return {
        "status": "accepted",
        "document_id": str(id),
        "rule_version_id": str(req.rule_version_id),
        "dry_run": req.dry_run,
    }
