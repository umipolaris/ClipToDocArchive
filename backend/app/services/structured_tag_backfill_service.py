from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    AuditLog,
    Document,
    DocumentFile,
    DocumentTag,
    DocumentVersion,
    File,
    SourceType,
    Tag,
)
from app.services.archive_set_parser import infer_structured_tags
from app.services.taxonomy_service import normalize_slug


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


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


def _get_primary_filename_map(db: Session, document_ids: list[UUID]) -> dict[UUID, str]:
    if not document_ids:
        return {}

    rows = db.execute(
        select(DocumentFile.document_id, func.coalesce(DocumentFile.display_filename, File.original_filename))
        .join(File, File.id == DocumentFile.file_id)
        .where(DocumentFile.document_id.in_(document_ids))
        .order_by(DocumentFile.document_id.asc(), DocumentFile.is_primary.desc(), DocumentFile.created_at.desc())
    ).all()

    filename_map: dict[UUID, str] = {}
    for document_id, original_filename in rows:
        if document_id in filename_map:
            continue
        filename_map[document_id] = original_filename or ""
    return filename_map


def _upsert_tags(db: Session, tag_names: list[str]) -> list[Tag]:
    tags: list[Tag] = []
    seen: set[str] = set()

    for raw_name in tag_names:
        name = raw_name.strip()
        if not name:
            continue

        slug = normalize_slug(name)
        if slug in seen:
            continue
        seen.add(slug)

        tag = db.execute(select(Tag).where(Tag.slug == slug)).scalar_one_or_none()
        if not tag:
            tag = Tag(name=name, slug=slug)
            db.add(tag)
            db.flush()
        tags.append(tag)

    return tags


def _replace_document_tags(db: Session, document_id: UUID, tag_names: list[str]) -> None:
    db.query(DocumentTag).filter(DocumentTag.document_id == document_id).delete(synchronize_session=False)
    for tag in _upsert_tags(db, tag_names):
        db.add(DocumentTag(document_id=document_id, tag_id=tag.id))
    db.flush()


def run_structured_tag_backfill(
    db: Session,
    *,
    batch_size: int = 500,
    limit: int | None = None,
    dry_run: bool = False,
    only_without_set: bool = False,
    source: SourceType | None = None,
) -> dict:
    if batch_size <= 0:
        batch_size = 500

    count_stmt = select(func.count(Document.id))
    if source:
        count_stmt = count_stmt.where(Document.source == source)
    total_candidates = db.execute(count_stmt).scalar_one()

    processed = 0
    updated = 0
    skipped = 0
    failed = 0
    offset = 0
    preview: list[dict] = []
    errors: list[dict] = []

    while True:
        stmt = select(Document).order_by(Document.ingested_at.desc()).offset(offset).limit(batch_size)
        if source:
            stmt = stmt.where(Document.source == source)
        docs = db.execute(stmt).scalars().all()
        if not docs:
            break

        doc_ids = [doc.id for doc in docs]
        tags_map = _get_document_tags_map(db, doc_ids)
        filename_map = _get_primary_filename_map(db, doc_ids)

        for doc in docs:
            if limit is not None and processed >= limit:
                return {
                    "status": "completed",
                    "dry_run": dry_run,
                    "total_candidates": total_candidates,
                    "processed": processed,
                    "updated": updated,
                    "skipped": skipped,
                    "failed": failed,
                    "preview": preview,
                    "errors": errors,
                    "finished_at": _now().isoformat(),
                }

            processed += 1
            existing_tags = tags_map.get(doc.id, [])
            if only_without_set and any(tag.lower().startswith("set:") for tag in existing_tags):
                skipped += 1
                continue

            filename = filename_map.get(doc.id, "")
            inferred = infer_structured_tags(
                title=doc.title,
                description=doc.description,
                filename=filename,
                existing_tags=existing_tags,
            )
            new_tags = sorted(set(existing_tags + inferred))
            added_tags = sorted(set(new_tags) - set(existing_tags))

            if not added_tags:
                skipped += 1
                continue

            if dry_run:
                updated += 1
                if len(preview) < 50:
                    preview.append(
                        {
                            "document_id": str(doc.id),
                            "title": doc.title,
                            "added_tags": added_tags,
                        }
                    )
                continue

            before_tags = sorted(existing_tags)
            try:
                _replace_document_tags(db, doc.id, new_tags)
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
                        tags_snapshot=new_tags,
                        change_reason="structured_tag_backfill",
                    )
                )
                db.add(
                    AuditLog(
                        action="DOCUMENT_STRUCTURED_TAG_BACKFILL",
                        target_type="document",
                        target_id=doc.id,
                        before_json={"tags": before_tags},
                        after_json={"tags": new_tags, "added_tags": added_tags},
                    )
                )
                db.commit()
                updated += 1
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                failed += 1
                if len(errors) < 50:
                    errors.append(
                        {
                            "document_id": str(doc.id),
                            "error": str(exc),
                        }
                    )

        offset += len(docs)

    return {
        "status": "completed",
        "dry_run": dry_run,
        "total_candidates": total_candidates,
        "processed": processed,
        "updated": updated,
        "skipped": skipped,
        "failed": failed,
        "preview": preview,
        "errors": errors,
        "finished_at": _now().isoformat(),
    }
