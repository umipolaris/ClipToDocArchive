from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, func, select
from sqlalchemy.orm import Session

from app.db.models import AuditLog, Document, DocumentFile, DocumentTag, DocumentVersion, File, ReviewStatus, RuleVersion, Tag
from app.services.caption_parser import parse_caption
from app.services.rule_engine import RuleInput, apply_rules
from app.services.search_sync_service import enqueue_document_index_sync_many
from app.services.taxonomy_service import replace_document_tags, upsert_category


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _get_tag_names(db: Session, document_id: UUID) -> list[str]:
    stmt = (
        select(Tag.name)
        .join(DocumentTag, DocumentTag.tag_id == Tag.id)
        .where(DocumentTag.document_id == document_id)
        .order_by(Tag.name.asc())
    )
    return list(db.execute(stmt).scalars().all())


def _get_primary_filename(db: Session, document_id: UUID) -> str:
    stmt = (
        select(func.coalesce(DocumentFile.display_filename, File.original_filename))
        .join(DocumentFile, DocumentFile.file_id == File.id)
        .where(DocumentFile.document_id == document_id)
        .order_by(DocumentFile.is_primary.desc())
        .limit(1)
    )
    filename = db.execute(stmt).scalar_one_or_none()
    return filename or "unknown.bin"


def _select_documents(filter_payload: dict[str, Any] | None) -> Select:
    stmt: Select = select(Document).order_by(Document.created_at.asc())

    if not filter_payload:
        return stmt

    filters = []
    category_id = filter_payload.get("category_id")
    if category_id:
        try:
            category_id = UUID(str(category_id))
        except ValueError:
            category_id = None
    if category_id:
        filters.append(Document.category_id == category_id)

    from_date = filter_payload.get("from")
    if from_date:
        try:
            if isinstance(from_date, str):
                from_date = date.fromisoformat(from_date)
            filters.append(Document.event_date >= from_date)
        except ValueError:
            pass

    to_date = filter_payload.get("to")
    if to_date:
        try:
            if isinstance(to_date, str):
                to_date = date.fromisoformat(to_date)
            filters.append(Document.event_date <= to_date)
        except ValueError:
            pass

    if filter_payload.get("review_only") is True:
        filters.append(Document.review_status == ReviewStatus.NEEDS_REVIEW)

    if filters:
        stmt = stmt.where(and_(*filters))

    return stmt


def process_backfill_payload(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    rule_version_id = payload.get("rule_version_id")
    if not rule_version_id:
        return {"status": "failed", "reason": "rule_version_id_required"}
    try:
        rule_version_id = UUID(str(rule_version_id))
    except ValueError:
        return {"status": "failed", "reason": "rule_version_id_invalid"}

    rv = db.execute(select(RuleVersion).where(RuleVersion.id == rule_version_id)).scalar_one_or_none()
    if not rv:
        return {"status": "failed", "reason": "rule_version_not_found"}

    batch_size = int(payload.get("batch_size") or 500)
    if batch_size <= 0:
        batch_size = 500

    filter_payload = payload.get("filter")
    base_stmt = _select_documents(filter_payload)

    audit_start = AuditLog(
        action="BACKFILL_START",
        target_type="rule_version",
        target_id=rv.id,
        after_json=payload,
    )
    db.add(audit_start)
    db.commit()

    updated = 0
    skipped = 0
    failed = 0
    updated_doc_ids: list[UUID] = []
    errors: list[dict[str, Any]] = []

    offset = 0
    while True:
        docs = db.execute(base_stmt.offset(offset).limit(batch_size)).scalars().all()
        if not docs:
            break

        for doc in docs:
            try:
                filename = _get_primary_filename(db, doc.id)
                parsed_caption = parse_caption(doc.caption_raw, filename)

                rule_out = apply_rules(
                    RuleInput(
                        caption=parsed_caption,
                        title=doc.title,
                        description=doc.description,
                        filename=filename,
                        body_text="",
                        metadata_date_text=None,
                        ingested_at=doc.ingested_at,
                    ),
                    rv.rules_json,
                )

                category = upsert_category(db, rule_out.category)
                new_category_id = category.id if category else None

                new_review_reasons = list(rule_out.review_reasons)
                if "DUPLICATE_SUSPECT" in doc.review_reasons and "DUPLICATE_SUSPECT" not in new_review_reasons:
                    new_review_reasons.append("DUPLICATE_SUSPECT")
                new_review_reasons = sorted(set(new_review_reasons))

                new_review_status = (
                    ReviewStatus.NEEDS_REVIEW if new_review_reasons else ReviewStatus.NONE
                )
                new_tag_names = sorted(set(tag.strip() for tag in rule_out.tags if tag.strip()))

                old_tag_names = _get_tag_names(db, doc.id)

                changed = (
                    doc.category_id != new_category_id
                    or doc.event_date != rule_out.event_date
                    or sorted(doc.review_reasons) != new_review_reasons
                    or doc.review_status != new_review_status
                    or sorted(old_tag_names) != new_tag_names
                )

                if not changed:
                    skipped += 1
                    continue

                if sorted(old_tag_names) != new_tag_names:
                    tags_snapshot = replace_document_tags(db, doc.id, new_tag_names)
                else:
                    tags_snapshot = old_tag_names

                before_json = {
                    "category_id": str(doc.category_id) if doc.category_id else None,
                    "event_date": doc.event_date.isoformat() if doc.event_date else None,
                    "review_status": doc.review_status.value,
                    "review_reasons": doc.review_reasons,
                    "tags": old_tag_names,
                }

                doc.category_id = new_category_id
                doc.event_date = rule_out.event_date
                doc.review_reasons = new_review_reasons
                doc.review_status = new_review_status
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
                        change_reason=f"backfill_rule_v{rv.version_no}",
                    )
                )

                after_json = {
                    "category_id": str(doc.category_id) if doc.category_id else None,
                    "event_date": doc.event_date.isoformat() if doc.event_date else None,
                    "review_status": doc.review_status.value,
                    "review_reasons": doc.review_reasons,
                    "tags": tags_snapshot,
                }
                db.add(
                    AuditLog(
                        action="DOCUMENT_BACKFILL_UPDATE",
                        target_type="document",
                        target_id=doc.id,
                        before_json=before_json,
                        after_json=after_json,
                    )
                )

                db.commit()
                updated += 1
                updated_doc_ids.append(doc.id)

            except Exception as exc:  # noqa: BLE001
                db.rollback()
                failed += 1
                if len(errors) < 30:
                    errors.append({"document_id": str(doc.id), "error": str(exc)})

        offset += batch_size

    summary = {
        "status": "completed",
        "rule_version_id": str(rv.id),
        "updated": updated,
        "skipped": skipped,
        "failed": failed,
        "errors": errors,
        "finished_at": _now().isoformat(),
    }

    db.add(
        AuditLog(
            action="BACKFILL_DONE",
            target_type="rule_version",
            target_id=rv.id,
            after_json=summary,
        )
    )
    db.commit()
    enqueue_document_index_sync_many(updated_doc_ids)

    return summary
