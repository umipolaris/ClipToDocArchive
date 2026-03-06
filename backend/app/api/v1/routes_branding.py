import hashlib
import mimetypes
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, File as UploadFormFile, HTTPException, UploadFile
from minio.error import S3Error
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.responses import FileResponse, StreamingResponse

from app.core.auth import CurrentUser, require_roles
from app.core.config import get_settings
from app.db.models import (
    AuditLog,
    BrandingSetting,
    DocumentFile,
    File as StoredFile,
    SourceType,
    UserRole,
)
from app.db.session import get_db
from app.schemas.branding import BrandingLogoDeleteResponse, BrandingLogoResponse
from app.services.dedupe_service import find_by_checksum
from app.services.storage_disk import delete_file as delete_file_disk, put_file_from_path as put_file_disk_from_path
from app.services.storage_minio import (
    delete_file as delete_file_minio,
    ensure_bucket,
    get_minio_client,
    put_file_from_path as put_file_minio_from_path,
)

router = APIRouter()
_UPLOAD_TMP_DIR = Path(tempfile.gettempdir()) / "doc-archive-branding-upload"
_UPLOAD_TMP_DIR.mkdir(parents=True, exist_ok=True)
_UPLOAD_CHUNK_SIZE = 1024 * 1024
_DOWNLOAD_CHUNK_SIZE = 1024 * 1024
_MAX_LOGO_BYTES = 10 * 1024 * 1024
_ALLOWED_LOGO_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _storage_key(checksum: str, extension: str | None) -> str:
    ext = (extension or "bin").lower().lstrip(".")
    return f"{checksum[0:2]}/{checksum[2:4]}/{checksum}.{ext}"


def _download_name(filename: str) -> str:
    normalized = Path(filename).name.strip()
    return normalized or "logo.bin"


def _content_disposition_inline(filename: str) -> str:
    encoded = quote(_download_name(filename))
    return f"inline; filename*=UTF-8''{encoded}"


def _ensure_branding_setting(db: Session, *, created_by) -> BrandingSetting:  # type: ignore[no-untyped-def]
    row = db.get(BrandingSetting, "default")
    if row:
        return row
    row = BrandingSetting(scope="default", logo_file_id=None, created_by=created_by)
    db.add(row)
    db.flush()
    return row


def _to_logo_response(row: BrandingSetting | None, file_row: StoredFile | None) -> BrandingLogoResponse:
    if row is None or row.logo_file_id is None or file_row is None:
        return BrandingLogoResponse(exists=False)
    return BrandingLogoResponse(
        exists=True,
        logo_file_id=file_row.id,
        image_url="/branding/logo/image",
        filename=file_row.original_filename,
        mime_type=file_row.mime_type,
        size_bytes=int(file_row.size_bytes or 0),
        updated_at=row.updated_at,
    )


def _validate_logo_upload(upload: UploadFile) -> tuple[str, str, str]:
    filename = upload.filename or "logo.bin"
    suffix = Path(filename).suffix.lower()
    content_type = (upload.content_type or "").lower().strip()
    guessed_mime, _ = mimetypes.guess_type(filename)
    mime_type = content_type or guessed_mime or "application/octet-stream"
    if suffix not in _ALLOWED_LOGO_SUFFIXES and not mime_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="logo file must be an image")
    if suffix == ".svg" and mime_type == "application/octet-stream":
        mime_type = "image/svg+xml"
    if not mime_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="unsupported logo content type")
    return filename, suffix, mime_type


def _store_logo_upload(db: Session, *, upload: UploadFile, created_by: UUID) -> StoredFile:
    filename, suffix, mime_type = _validate_logo_upload(upload)
    fd, tmp_path_raw = tempfile.mkstemp(prefix="branding_logo_", suffix=suffix, dir=_UPLOAD_TMP_DIR)
    tmp_path = Path(tmp_path_raw)
    checksum_sha256 = hashlib.sha256()
    size_bytes = 0
    try:
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = upload.file.read(_UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                checksum_sha256.update(chunk)
                size_bytes += len(chunk)
                if size_bytes > _MAX_LOGO_BYTES:
                    raise HTTPException(status_code=413, detail="logo file too large (max 10MB)")
                out.write(chunk)

        if size_bytes <= 0:
            raise HTTPException(status_code=400, detail="empty logo file")

        checksum = checksum_sha256.hexdigest()
        existing = find_by_checksum(db, checksum)
        if existing:
            return existing

        extension = suffix.lstrip(".") or None
        storage_key = _storage_key(checksum, extension)
        settings = get_settings()

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
            source=SourceType.manual,
            source_ref="branding:logo",
            storage_backend=settings.storage_backend,
            bucket=settings.storage_bucket,
            storage_key=storage_key,
            original_filename=filename,
            uploaded_filename=filename,
            extension=extension,
            checksum_sha256=checksum,
            mime_type=mime_type,
            size_bytes=size_bytes,
            metadata_json={"kind": "branding_logo"},
            created_by=created_by,
        )
        db.add(row)
        db.flush()
        return row
    finally:
        tmp_path.unlink(missing_ok=True)


def _delete_stored_object(file_row: StoredFile) -> None:
    settings = get_settings()
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


def _cleanup_orphan_logo_file(db: Session, *, file_id: UUID) -> bool:
    file_row = db.get(StoredFile, file_id)
    if not file_row:
        return False
    doc_links = int(
        db.execute(select(func.count()).select_from(DocumentFile).where(DocumentFile.file_id == file_id)).scalar_one() or 0
    )
    branding_links = int(
        db.execute(
            select(func.count()).select_from(BrandingSetting).where(BrandingSetting.logo_file_id == file_id)
        ).scalar_one()
        or 0
    )
    if doc_links > 0 or branding_links > 0:
        return False
    _delete_stored_object(file_row)
    db.delete(file_row)
    db.flush()
    return True


@router.get("/branding/logo", response_model=BrandingLogoResponse)
def get_branding_logo(
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BrandingLogoResponse:
    row = db.get(BrandingSetting, "default")
    if not row or not row.logo_file_id:
        return BrandingLogoResponse(exists=False)
    file_row = db.get(StoredFile, row.logo_file_id)
    if not file_row:
        row.logo_file_id = None
        row.updated_at = _now()
        db.add(row)
        db.commit()
        return BrandingLogoResponse(exists=False)
    return _to_logo_response(row, file_row)


@router.get("/branding/logo/image")
def get_branding_logo_image(
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(BrandingSetting, "default")
    if not row or not row.logo_file_id:
        raise HTTPException(status_code=404, detail="branding logo not configured")

    file_row = db.get(StoredFile, row.logo_file_id)
    if not file_row:
        raise HTTPException(status_code=404, detail="branding logo file not found")

    settings = get_settings()
    headers = {
        "Content-Disposition": _content_disposition_inline(file_row.original_filename),
        "Cache-Control": "no-store",
    }
    if file_row.storage_backend == "minio":
        client = get_minio_client(
            endpoint=settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )
        try:
            minio_resp = client.get_object(bucket_name=file_row.bucket, object_name=file_row.storage_key)
        except S3Error as exc:
            if exc.code in {"NoSuchKey", "NoSuchObject", "NoSuchBucket"}:
                raise HTTPException(status_code=404, detail="branding logo object not found") from exc
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
            media_type=file_row.mime_type or "application/octet-stream",
            headers=headers,
        )

    file_path = Path(settings.storage_disk_root) / file_row.storage_key
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="branding logo object not found")
    return FileResponse(
        path=str(file_path),
        media_type=file_row.mime_type or "application/octet-stream",
        headers=headers,
    )


@router.post("/admin/branding/logo", response_model=BrandingLogoResponse)
def upload_branding_logo(
    file: UploadFile = UploadFormFile(...),
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BrandingLogoResponse:
    try:
        row = _ensure_branding_setting(db, created_by=current_user.id)
        before_file_id = row.logo_file_id
        stored = _store_logo_upload(db, upload=file, created_by=current_user.id)
        row.logo_file_id = stored.id
        row.updated_at = _now()
        db.add(row)
        db.add(
            AuditLog(
                actor_user_id=current_user.id,
                action="BRANDING_LOGO_UPSERT",
                target_type="branding_logo",
                target_id=stored.id,
                before_json={"logo_file_id": str(before_file_id) if before_file_id else None},
                after_json={"logo_file_id": str(stored.id)},
            )
        )
        db.commit()
        db.refresh(row)

        if before_file_id and before_file_id != stored.id:
            try:
                if _cleanup_orphan_logo_file(db, file_id=before_file_id):
                    db.commit()
            except Exception:  # noqa: BLE001
                db.rollback()

        return _to_logo_response(row, stored)
    finally:
        file.file.close()


@router.delete("/admin/branding/logo", response_model=BrandingLogoDeleteResponse)
def delete_branding_logo(
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BrandingLogoDeleteResponse:
    row = _ensure_branding_setting(db, created_by=current_user.id)
    previous_file_id = row.logo_file_id
    if previous_file_id is None:
        return BrandingLogoDeleteResponse(status="ok", removed=False, previous_file_id=None)

    row.logo_file_id = None
    row.updated_at = _now()
    db.add(row)
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="BRANDING_LOGO_DELETE",
            target_type="branding_logo",
            target_id=previous_file_id,
            before_json={"logo_file_id": str(previous_file_id)},
            after_json={"logo_file_id": None},
        )
    )
    db.commit()

    try:
        if _cleanup_orphan_logo_file(db, file_id=previous_file_id):
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()

    return BrandingLogoDeleteResponse(status="ok", removed=True, previous_file_id=previous_file_id)

