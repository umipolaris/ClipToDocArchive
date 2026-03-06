from datetime import date, datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Date, Integer, cast, extract, func, literal, or_, select
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, require_roles
from app.db.models import Category, Document, DocumentCategory, DocumentFile, DocumentTag, ReviewStatus, Tag, UserRole
from app.db.session import get_db
from app.schemas.archive import (
    ArchiveCategoryNode,
    ArchiveMonthNode,
    ArchiveSetDocumentNode,
    ArchiveSetNode,
    ArchiveSetRevisionItem,
    ArchiveSetsResponse,
    ArchiveTreeResponse,
    ArchiveYearNode,
)
from app.services.archive_set_parser import (
    extract_structured_fields,
    humanize_key,
    normalize_key,
    revision_rank,
)

router = APIRouter()


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _get_document_file_counts(db: Session, document_ids: list[UUID]) -> dict[UUID, int]:
    if not document_ids:
        return {}
    rows = db.execute(
        select(
            DocumentFile.document_id,
            func.count(func.distinct(DocumentFile.file_id)).label("file_count"),
        )
        .where(DocumentFile.document_id.in_(document_ids))
        .group_by(DocumentFile.document_id)
    ).all()
    return {row.document_id: int(row.file_count or 0) for row in rows}


def _get_document_tags(db: Session, document_ids: list[UUID]) -> dict[UUID, list[str]]:
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


@router.get("/archive/tree", response_model=ArchiveTreeResponse)
def get_archive_tree(
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> ArchiveTreeResponse:
    base_date = func.coalesce(Document.event_date, cast(Document.ingested_at, Date))
    year_col = cast(extract("year", base_date), Integer).label("year")
    month_col = cast(extract("month", base_date), Integer).label("month")

    categorized_rows = db.execute(
        select(
            Category.name.label("category"),
            year_col,
            month_col,
            func.count(func.distinct(Document.id)).label("count"),
        )
        .select_from(Document)
        .join(DocumentCategory, DocumentCategory.document_id == Document.id)
        .join(Category, Category.id == DocumentCategory.category_id)
        .group_by(Category.name, year_col, month_col)
        .order_by(Category.name.asc(), year_col.desc(), month_col.desc())
    ).all()

    uncategorized_exists = (
        select(1)
        .select_from(DocumentCategory)
        .where(DocumentCategory.document_id == Document.id)
        .exists()
    )
    uncategorized_rows = db.execute(
        select(
            literal("미분류").label("category"),
            year_col,
            month_col,
            func.count(Document.id).label("count"),
        )
        .select_from(Document)
        .where(~uncategorized_exists)
        .group_by(year_col, month_col)
        .order_by(year_col.desc(), month_col.desc())
    ).all()

    rows = [*categorized_rows, *uncategorized_rows]

    bucket: dict[str, dict] = {}
    for row in rows:
        category_name: str = row.category
        year: int = int(row.year)
        month: int = int(row.month)
        count: int = int(row.count)

        cat = bucket.setdefault(
            category_name,
            {
                "count": 0,
                "years": {},
            },
        )
        cat["count"] += count

        year_data = cat["years"].setdefault(
            year,
            {
                "count": 0,
                "months": {},
            },
        )
        year_data["count"] += count
        year_data["months"][month] = year_data["months"].get(month, 0) + count

    categories: list[ArchiveCategoryNode] = []
    for category_name in sorted(bucket.keys()):
        cat = bucket[category_name]
        years: list[ArchiveYearNode] = []
        for year in sorted(cat["years"].keys(), reverse=True):
            year_data = cat["years"][year]
            months = [
                ArchiveMonthNode(month=month, count=year_data["months"][month])
                for month in sorted(year_data["months"].keys(), reverse=True)
            ]
            years.append(ArchiveYearNode(year=year, count=year_data["count"], months=months))
        categories.append(ArchiveCategoryNode(category=category_name, count=cat["count"], years=years))

    return ArchiveTreeResponse(categories=categories, generated_at=_now())


@router.get("/archive/sets", response_model=ArchiveSetsResponse)
def get_archive_sets(
    q: str | None = Query(None, description="제목/설명/태그 부분일치 검색"),
    include_unmapped: bool = Query(True, description="set:* 태그가 없는 문서 포함 여부"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    document_limit: int = Query(50, ge=5, le=200, description="세트별 문서 그룹 최대 반환 수"),
    revision_limit: int = Query(20, ge=1, le=100, description="문서 그룹별 리비전 최대 반환 수"),
    max_documents_scanned: int = Query(5000, ge=100, le=20000, description="요청당 최대 스캔 문서 수"),
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> ArchiveSetsResponse:
    stmt = (
        select(
            Document.id.label("document_id"),
            Document.title,
            Document.description,
            Document.event_date,
            Document.ingested_at,
            Document.review_status,
            Document.source_ref,
            Category.name.label("category"),
        )
        .select_from(Document)
        .outerjoin(Category, Category.id == Document.category_id)
        .order_by(Document.event_date.desc().nullslast(), Document.ingested_at.desc())
        .limit(max_documents_scanned + 1)
    )

    if q and q.strip():
        keyword = f"%{q.strip().lower()}%"
        tag_match_exists = (
            select(1)
            .select_from(DocumentTag)
            .join(Tag, Tag.id == DocumentTag.tag_id)
            .where(
                DocumentTag.document_id == Document.id,
                func.lower(Tag.name).like(keyword),
            )
            .exists()
        )
        stmt = stmt.where(
            or_(
                func.lower(Document.title).like(keyword),
                func.lower(Document.description).like(keyword),
                tag_match_exists,
            )
        )

    rows = db.execute(stmt).all()
    truncated = len(rows) > max_documents_scanned
    if truncated:
        rows = rows[:max_documents_scanned]
    document_ids = [row.document_id for row in rows]
    file_count_map = _get_document_file_counts(db, document_ids)
    tags_map = _get_document_tags(db, document_ids)

    set_bucket: dict[str, dict] = {}
    for row in rows:
        raw_tags = tags_map.get(row.document_id, [])
        tags = sorted({tag for tag in raw_tags if tag})
        parsed = extract_structured_fields(tags, row.title, row.category)

        raw_set_key = parsed["set_key"] or "__unmapped__"
        if raw_set_key == "__unmapped__" and not include_unmapped:
            continue

        set_key = "__unmapped__" if raw_set_key == "__unmapped__" else normalize_key(raw_set_key)
        set_label = "세트 미지정" if raw_set_key == "__unmapped__" else humanize_key(raw_set_key)

        set_node = set_bucket.setdefault(
            set_key,
            {
                "set_key": set_key,
                "set_label": set_label,
                "documents": {},
            },
        )

        raw_document_key = parsed["document_key"] or "Untitled"
        document_group_key = normalize_key(raw_document_key)
        document_node = set_node["documents"].setdefault(
            document_group_key,
            {
                "document_key": raw_document_key,
                "revisions": [],
            },
        )

        revision = ArchiveSetRevisionItem(
            document_id=row.document_id,
            title=row.title,
            category=row.category,
            event_date=row.event_date,
            ingested_at=row.ingested_at,
            review_status=row.review_status,
            file_count=file_count_map.get(row.document_id, 0),
            tags=tags,
            revision=parsed["revision"],
            kind=parsed["kind"],
            language=parsed["language"],
            source_ref=row.source_ref,
        )
        document_node["revisions"].append(revision)

    set_nodes: list[ArchiveSetNode] = []
    for raw_set in set_bucket.values():
        doc_nodes: list[ArchiveSetDocumentNode] = []
        for raw_doc in raw_set["documents"].values():
            revisions: list[ArchiveSetRevisionItem] = raw_doc["revisions"]
            revisions.sort(
                key=lambda item: (
                    item.event_date or date.min,
                    item.ingested_at,
                    revision_rank(item.revision),
                ),
                reverse=True,
            )

            latest_event_date = next((r.event_date for r in revisions if r.event_date is not None), None)
            revision_count = len(revisions)
            needs_review_count = sum(1 for r in revisions if r.review_status == ReviewStatus.NEEDS_REVIEW)
            kinds = sorted({r.kind for r in revisions if r.kind})

            doc_nodes.append(
                ArchiveSetDocumentNode(
                    document_key=raw_doc["document_key"],
                    display_title=revisions[0].title if revisions else raw_doc["document_key"],
                    latest_event_date=latest_event_date,
                    revision_count=revision_count,
                    needs_review_count=needs_review_count,
                    kinds=kinds,
                    revisions=revisions[:revision_limit],
                    has_more_revisions=revision_count > revision_limit,
                )
            )

        doc_nodes.sort(
            key=lambda item: (
                item.latest_event_date or date.min,
                item.display_title.lower(),
            ),
            reverse=True,
        )

        latest_event_date = next((d.latest_event_date for d in doc_nodes if d.latest_event_date is not None), None)
        document_count = len(doc_nodes)
        set_nodes.append(
            ArchiveSetNode(
                set_key=raw_set["set_key"],
                set_label=raw_set["set_label"],
                latest_event_date=latest_event_date,
                document_count=document_count,
                revision_count=sum(d.revision_count for d in doc_nodes),
                needs_review_count=sum(d.needs_review_count for d in doc_nodes),
                documents=doc_nodes[:document_limit],
                has_more_documents=document_count > document_limit,
            )
        )

    set_nodes.sort(
        key=lambda item: (
            item.latest_event_date or date.min,
            item.set_label.lower(),
        ),
        reverse=True,
    )

    total_sets = len(set_nodes)
    start = (page - 1) * size
    end = start + size
    items = set_nodes[start:end]

    return ArchiveSetsResponse(
        items=items,
        page=page,
        size=size,
        total_sets=total_sets,
        generated_at=_now(),
        truncated=truncated,
        max_documents_scanned=max_documents_scanned,
    )
