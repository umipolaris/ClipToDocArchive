from datetime import date, datetime, timedelta, timezone
import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, literal, select
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, require_roles
from app.db.models import (
    Category,
    DashboardMilestone,
    DashboardTask,
    DashboardTaskKind,
    DashboardTaskSetting,
    DocumentFile,
    Document,
    File,
    IngestJob,
    IngestState,
    ReviewStatus,
    UserRole,
)
from app.db.session import get_db
from app.schemas.dashboard import (
    DashboardCategoryCount,
    DashboardMilestoneCreateRequest,
    DashboardMilestoneItem,
    DashboardMilestoneListResponse,
    DashboardMilestoneUpdateRequest,
    DashboardTaskCreateRequest,
    DashboardTaskItem,
    DashboardTaskListResponse,
    DashboardTaskSettingsResponse,
    DashboardTaskSettingsUpdateRequest,
    DashboardTaskUpdateRequest,
    DashboardErrorCodeCount,
    DashboardPinnedCategory,
    DashboardPinnedDocument,
    DashboardRecentDocument,
    DashboardSummaryResponse,
)

router = APIRouter()

DEFAULT_TASK_CATEGORIES = ["할일", "회의"]
DEFAULT_MILESTONE_START_YEAR = 2025
DEFAULT_MILESTONE_END_YEAR = 2032
DEFAULT_CATEGORY_COLORS = {
    "할일": "#059669",
    "회의": "#0284C7",
}
DEFAULT_TASK_LIST_RANGE_PAST_DAYS = 7
DEFAULT_TASK_LIST_RANGE_FUTURE_MONTHS = 2
MIN_TASK_LIST_RANGE_PAST_DAYS = 0
MAX_TASK_LIST_RANGE_PAST_DAYS = 365
MIN_TASK_LIST_RANGE_FUTURE_MONTHS = 0
MAX_TASK_LIST_RANGE_FUTURE_MONTHS = 24
MAX_TASK_HOLIDAYS = 400
TASK_COLOR_PALETTE = [
    "#059669",
    "#0284C7",
    "#7C3AED",
    "#EA580C",
    "#D9466F",
    "#0F766E",
    "#475569",
    "#7C2D12",
    "#166534",
]


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _month_bounds(month: str | None) -> tuple[datetime, datetime, str]:
    now = _now()
    if month:
        text = month.strip()
        parts = text.split("-")
        if len(parts) != 2:
            raise HTTPException(status_code=400, detail="invalid month format")
        try:
            year = int(parts[0])
            mon = int(parts[1])
            if year < 1970 or year > 2100 or mon < 1 or mon > 12:
                raise ValueError
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid month format") from exc
    else:
        year = now.year
        mon = now.month

    start = datetime(year, mon, 1, tzinfo=timezone.utc)
    if mon == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, mon + 1, 1, tzinfo=timezone.utc)
    month_key = f"{year:04d}-{mon:02d}"
    return start, end, month_key


def _normalize_task_list_range_past_days(raw: int | None) -> int:
    value = DEFAULT_TASK_LIST_RANGE_PAST_DAYS if raw is None else int(raw)
    return max(MIN_TASK_LIST_RANGE_PAST_DAYS, min(MAX_TASK_LIST_RANGE_PAST_DAYS, value))


def _normalize_task_list_range_future_months(raw: int | None) -> int:
    value = DEFAULT_TASK_LIST_RANGE_FUTURE_MONTHS if raw is None else int(raw)
    return max(MIN_TASK_LIST_RANGE_FUTURE_MONTHS, min(MAX_TASK_LIST_RANGE_FUTURE_MONTHS, value))


def _normalize_milestone_year(value: int | None, *, fallback: int, minimum: int, maximum: int) -> int:
    year = fallback if value is None else int(value)
    return max(minimum, min(maximum, year))


def _to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _normalize_categories(raw: list[str] | None) -> list[str]:
    if not raw:
        return DEFAULT_TASK_CATEGORIES
    out: list[str] = []
    seen: set[str] = set()
    for name in raw:
        token = str(name).strip()
        if not token:
            continue
        if len(token) > 80:
            token = token[:80]
        key = token.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(token)
    if not out:
        return DEFAULT_TASK_CATEGORIES
    return out[:30]


def _is_valid_time_hhmm(value: str) -> bool:
    return bool(re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value))


def _normalize_hex_color(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", text):
        return "#" + "".join(ch * 2 for ch in text[1:]).upper()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return text.upper()
    return None


def _normalize_milestone_color(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = _normalize_hex_color(value)
    if normalized is None:
        raise HTTPException(status_code=400, detail="milestone color must be a hex value like #0F766E")
    return normalized


def _default_color_for_category(name: str) -> str:
    if name in DEFAULT_CATEGORY_COLORS:
        return DEFAULT_CATEGORY_COLORS[name]
    idx = sum(ord(ch) for ch in name) % len(TASK_COLOR_PALETTE)
    return TASK_COLOR_PALETTE[idx]


def _normalize_category_colors(raw: dict | None, categories: list[str]) -> dict[str, str]:
    source = raw or {}
    normalized: dict[str, str] = {}
    for category in categories:
        raw_color = source.get(category) if isinstance(source, dict) else None
        color = _normalize_hex_color(str(raw_color)) if raw_color is not None else None
        normalized[category] = color or _default_color_for_category(category)
    return normalized


def _normalize_holidays(raw: dict | None) -> dict[str, str]:
    source = raw if isinstance(raw, dict) else {}
    normalized: dict[str, str] = {}
    for raw_day, raw_name in source.items():
        day_text = str(raw_day).strip()
        try:
            day_value = date.fromisoformat(day_text)
        except ValueError:
            continue
        day_key = day_value.isoformat()
        name = str(raw_name).strip()
        if not name:
            continue
        normalized[day_key] = name[:80]
    ordered_items = sorted(normalized.items(), key=lambda item: item[0])[:MAX_TASK_HOLIDAYS]
    return {key: value for key, value in ordered_items}


def _get_task_settings_row(db: Session) -> DashboardTaskSetting:
    row = db.get(DashboardTaskSetting, "default")
    if row is None:
        row = DashboardTaskSetting(
            scope="default",
            categories_json=DEFAULT_TASK_CATEGORIES,
            category_colors_json=DEFAULT_CATEGORY_COLORS,
            holidays_json={},
            allow_all_day=True,
            use_location=True,
            use_comment=True,
            default_time="09:00",
            list_range_past_days=DEFAULT_TASK_LIST_RANGE_PAST_DAYS,
            list_range_future_months=DEFAULT_TASK_LIST_RANGE_FUTURE_MONTHS,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _derive_task_kind(category: str) -> DashboardTaskKind:
    if "회의" in category.lower():
        return DashboardTaskKind.MEETING
    return DashboardTaskKind.TODO


def _normalize_task_ended_at(*, scheduled_at: datetime, ended_at: datetime | None, all_day: bool) -> datetime | None:
    if all_day:
        return None
    if ended_at is None:
        return None
    normalized_end = _to_utc(ended_at)
    if normalized_end <= scheduled_at:
        raise HTTPException(status_code=400, detail="ended_at must be greater than scheduled_at")
    return normalized_end


def _normalize_milestone_dates(*, start_date: date, end_date: date | None) -> tuple[date, date | None]:
    if end_date is not None and end_date < start_date:
        raise HTTPException(status_code=400, detail="end_date must be greater than or equal to start_date")
    return start_date, end_date


def _normalize_milestone_title(raw: str) -> str:
    title = raw.strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    return title


def _normalize_milestone_description(raw: str | None) -> str:
    return (raw or "").strip()


def _to_dashboard_milestone_item(row: DashboardMilestone) -> DashboardMilestoneItem:
    return DashboardMilestoneItem(
        id=row.id,
        title=row.title,
        start_date=row.start_date,
        end_date=row.end_date,
        description=row.description or "",
        color=row.color,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _task_file_download_path(document_id: UUID | None, file_id: UUID | None) -> str | None:
    if file_id is None:
        return None
    if document_id is not None:
        return f"/documents/{document_id}/files/{file_id}/download"
    return f"/files/{file_id}/download"


def _normalize_task_linked_file(
    db: Session,
    linked_document_id: UUID | None,
    linked_file_id: UUID | None,
) -> tuple[UUID | None, UUID | None]:
    if linked_document_id is None and linked_file_id is None:
        return None, None
    if linked_document_id is None or linked_file_id is None:
        raise HTTPException(status_code=400, detail="linked_document_id and linked_file_id must be provided together")
    if db.get(Document, linked_document_id) is None:
        raise HTTPException(status_code=400, detail="linked_document_id not found")
    relation = db.execute(
        select(DocumentFile.document_id)
        .where(DocumentFile.document_id == linked_document_id, DocumentFile.file_id == linked_file_id)
        .limit(1)
    ).scalar_one_or_none()
    if relation is None:
        raise HTTPException(status_code=400, detail="linked_file_id does not belong to linked_document_id")
    return linked_document_id, linked_file_id


def _task_with_link_meta_stmt():  # noqa: ANN202
    linked_filename = func.coalesce(DocumentFile.display_filename, File.original_filename).label("linked_file_name")
    return (
        select(
            DashboardTask,
            Document.title.label("linked_document_title"),
            linked_filename,
        )
        .outerjoin(Document, Document.id == DashboardTask.linked_document_id)
        .outerjoin(
            DocumentFile,
            (DocumentFile.document_id == DashboardTask.linked_document_id)
            & (DocumentFile.file_id == DashboardTask.linked_file_id),
        )
        .outerjoin(File, File.id == DashboardTask.linked_file_id)
    )


def _to_dashboard_task_item(
    task: DashboardTask,
    *,
    linked_document_title: str | None,
    linked_file_name: str | None,
) -> DashboardTaskItem:
    return DashboardTaskItem(
        id=task.id,
        category=task.category,
        title=task.title,
        scheduled_at=task.scheduled_at,
        ended_at=task.ended_at,
        all_day=task.all_day,
        location=task.location,
        comment=task.comment,
        linked_document_id=task.linked_document_id,
        linked_document_title=linked_document_title,
        linked_file_id=task.linked_file_id,
        linked_file_name=linked_file_name,
        linked_file_download_path=_task_file_download_path(task.linked_document_id, task.linked_file_id),
    )


@router.get("/dashboard/summary", response_model=DashboardSummaryResponse)
def get_dashboard_summary(
    recent_limit: int = Query(10, ge=1, le=50),
    pinned_per_category: int = Query(5, ge=1, le=20),
    pinned_category_limit: int = Query(20, ge=1, le=100),
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DashboardSummaryResponse:
    now = _now()
    recent_cutoff = now - timedelta(days=7)

    total_documents = db.execute(select(func.count(Document.id))).scalar_one()
    recent_uploads_7d = db.execute(
        select(func.count(Document.id)).where(Document.ingested_at >= recent_cutoff)
    ).scalar_one()
    needs_review_count = db.execute(
        select(func.count(Document.id)).where(Document.review_status == ReviewStatus.NEEDS_REVIEW)
    ).scalar_one()
    failed_jobs_count = db.execute(
        select(func.count(IngestJob.id)).where(IngestJob.state == IngestState.FAILED)
    ).scalar_one()
    retry_scheduled_count = db.execute(
        select(func.count(IngestJob.id)).where(
            IngestJob.state == IngestState.RECEIVED,
            IngestJob.retry_after.is_not(None),
        )
    ).scalar_one()
    dead_letter_count = db.execute(
        select(func.count(IngestJob.id)).where(
            IngestJob.state == IngestState.FAILED,
            IngestJob.last_error_code == "DLQ_MAX_ATTEMPTS",
        )
    ).scalar_one()

    error_code_label = func.coalesce(IngestJob.last_error_code, literal("UNKNOWN")).label("error_code")
    error_rows = db.execute(
        select(error_code_label, func.count(IngestJob.id).label("count"))
        .where(IngestJob.state == IngestState.FAILED)
        .group_by(error_code_label)
        .order_by(func.count(IngestJob.id).desc(), error_code_label.asc())
        .limit(10)
    ).all()
    failed_error_codes = [
        DashboardErrorCodeCount(error_code=row.error_code, count=row.count)
        for row in error_rows
    ]

    category_label = func.coalesce(Category.name, literal("미분류")).label("category")
    category_rows = db.execute(
        select(category_label, func.count(Document.id).label("count"))
        .select_from(Document)
        .outerjoin(Category, Category.id == Document.category_id)
        .group_by(category_label)
        .order_by(func.count(Document.id).desc(), category_label.asc())
        .limit(20)
    ).all()
    categories = [DashboardCategoryCount(category=row.category, count=row.count) for row in category_rows]

    pinned_category_label = func.coalesce(Category.name, literal("미분류")).label("category")
    pinned_rows = db.execute(
        select(
            Document.id,
            Document.title,
            Document.event_date,
            Document.ingested_at,
            Document.review_status,
            pinned_category_label,
        )
        .select_from(Document)
        .outerjoin(Category, Category.id == Document.category_id)
        .where(Document.is_pinned.is_(True))
        .order_by(
            pinned_category_label.asc(),
            Document.pinned_at.desc().nullslast(),
            Document.ingested_at.desc(),
        )
        .limit(max(200, pinned_per_category * pinned_category_limit * 2))
    ).all()

    pinned_by_category: list[DashboardPinnedCategory] = []
    pinned_map: dict[str, list[DashboardPinnedDocument]] = {}
    pinned_counts: dict[str, int] = {}
    for row in pinned_rows:
        pinned_counts[row.category] = pinned_counts.get(row.category, 0) + 1
        docs = pinned_map.setdefault(row.category, [])
        if len(docs) >= pinned_per_category:
            continue
        docs.append(
            DashboardPinnedDocument(
                id=row.id,
                title=row.title,
                category=row.category,
                event_date=row.event_date,
                ingested_at=row.ingested_at,
                review_status=row.review_status,
            )
        )

    for category_name in sorted(pinned_map.keys()):
        docs = pinned_map[category_name]
        pinned_by_category.append(
            DashboardPinnedCategory(
                category=category_name,
                count=pinned_counts.get(category_name, len(docs)),
                documents=docs,
            )
        )
        if len(pinned_by_category) >= pinned_category_limit:
            break

    first_file_id = (
        select(File.id)
        .select_from(DocumentFile)
        .join(File, File.id == DocumentFile.file_id)
        .where(DocumentFile.document_id == Document.id)
        .order_by(
            DocumentFile.created_at.asc(),
            func.coalesce(DocumentFile.display_filename, File.original_filename).asc(),
        )
        .limit(1)
        .scalar_subquery()
    )

    first_file_extension = (
        select(File.extension)
        .select_from(DocumentFile)
        .join(File, File.id == DocumentFile.file_id)
        .where(DocumentFile.document_id == Document.id)
        .order_by(
            DocumentFile.created_at.asc(),
            func.coalesce(DocumentFile.display_filename, File.original_filename).asc(),
        )
        .limit(1)
        .scalar_subquery()
    )

    recent_rows = db.execute(
        select(
            Document.id,
            Document.title,
            Document.event_date,
            Document.ingested_at,
            Document.review_status,
            func.coalesce(Category.name, literal("미분류")).label("category"),
            first_file_id.label("first_file_id"),
            first_file_extension.label("first_file_extension"),
        )
        .select_from(Document)
        .outerjoin(Category, Category.id == Document.category_id)
        .order_by(Document.ingested_at.desc())
        .limit(recent_limit)
    ).all()
    recent_documents = [
        DashboardRecentDocument(
            id=row.id,
            title=row.title,
            category=row.category,
            first_file_id=row.first_file_id,
            first_file_extension=row.first_file_extension,
            event_date=row.event_date,
            ingested_at=row.ingested_at,
            review_status=row.review_status,
        )
        for row in recent_rows
    ]

    return DashboardSummaryResponse(
        total_documents=total_documents,
        recent_uploads_7d=recent_uploads_7d,
        needs_review_count=needs_review_count,
        failed_jobs_count=failed_jobs_count,
        retry_scheduled_count=retry_scheduled_count,
        dead_letter_count=dead_letter_count,
        failed_error_codes=failed_error_codes,
        categories=categories,
        pinned_by_category=pinned_by_category,
        recent_documents=recent_documents,
        generated_at=now,
    )


@router.get("/dashboard/milestones", response_model=DashboardMilestoneListResponse)
def get_dashboard_milestones(
    start_year: int = Query(DEFAULT_MILESTONE_START_YEAR, ge=2000, le=2100),
    end_year: int = Query(DEFAULT_MILESTONE_END_YEAR, ge=2000, le=2100),
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DashboardMilestoneListResponse:
    normalized_start_year = _normalize_milestone_year(
        start_year,
        fallback=DEFAULT_MILESTONE_START_YEAR,
        minimum=2000,
        maximum=2100,
    )
    normalized_end_year = _normalize_milestone_year(
        end_year,
        fallback=DEFAULT_MILESTONE_END_YEAR,
        minimum=normalized_start_year,
        maximum=2100,
    )
    if normalized_end_year < normalized_start_year:
        raise HTTPException(status_code=400, detail="end_year must be greater than or equal to start_year")

    start_day = date(normalized_start_year, 1, 1)
    end_day = date(normalized_end_year, 12, 31)
    rows = db.execute(
        select(DashboardMilestone)
        .where(
            DashboardMilestone.start_date <= end_day,
            func.coalesce(DashboardMilestone.end_date, DashboardMilestone.start_date) >= start_day,
        )
        .order_by(DashboardMilestone.start_date.asc(), DashboardMilestone.title.asc(), DashboardMilestone.id.asc())
    ).scalars().all()

    return DashboardMilestoneListResponse(
        start_year=normalized_start_year,
        end_year=normalized_end_year,
        items=[_to_dashboard_milestone_item(row) for row in rows],
        generated_at=_now(),
    )


@router.post("/dashboard/milestones", response_model=DashboardMilestoneItem)
def create_dashboard_milestone(
    req: DashboardMilestoneCreateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN, UserRole.EDITOR)),
    db: Session = Depends(get_db),
) -> DashboardMilestoneItem:
    start_date, end_date = _normalize_milestone_dates(start_date=req.start_date, end_date=req.end_date)
    row = DashboardMilestone(
        title=_normalize_milestone_title(req.title),
        start_date=start_date,
        end_date=end_date,
        description=_normalize_milestone_description(req.description),
        color=_normalize_milestone_color(req.color),
        created_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_dashboard_milestone_item(row)


@router.patch("/dashboard/milestones/{milestone_id}", response_model=DashboardMilestoneItem)
def update_dashboard_milestone(
    milestone_id: UUID,
    req: DashboardMilestoneUpdateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN, UserRole.EDITOR)),
    db: Session = Depends(get_db),
) -> DashboardMilestoneItem:
    row = db.get(DashboardMilestone, milestone_id)
    if row is None:
        raise HTTPException(status_code=404, detail="milestone not found")
    start_date, end_date = _normalize_milestone_dates(start_date=req.start_date, end_date=req.end_date)
    row.title = _normalize_milestone_title(req.title)
    row.start_date = start_date
    row.end_date = end_date
    row.description = _normalize_milestone_description(req.description)
    row.color = _normalize_milestone_color(req.color)
    row.created_by = current_user.id
    row.updated_at = _now()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_dashboard_milestone_item(row)


@router.delete("/dashboard/milestones/{milestone_id}", status_code=204)
def delete_dashboard_milestone(
    milestone_id: UUID,
    _: CurrentUser = Depends(require_roles(UserRole.ADMIN, UserRole.EDITOR)),
    db: Session = Depends(get_db),
) -> None:
    row = db.get(DashboardMilestone, milestone_id)
    if row is None:
        raise HTTPException(status_code=404, detail="milestone not found")
    db.delete(row)
    db.commit()


@router.get("/dashboard/tasks", response_model=DashboardTaskListResponse)
def get_dashboard_tasks(
    month: str | None = Query(None, description="YYYY-MM"),
    start_at: datetime | None = Query(None, description="ISO8601 datetime (inclusive)"),
    end_at: datetime | None = Query(None, description="ISO8601 datetime (exclusive)"),
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DashboardTaskListResponse:
    if start_at is not None or end_at is not None:
        if start_at is None or end_at is None:
            raise HTTPException(status_code=400, detail="start_at and end_at must be provided together")
        if month is not None and month.strip():
            raise HTTPException(status_code=400, detail="month cannot be combined with start_at/end_at")
        start = _to_utc(start_at)
        end = _to_utc(end_at)
        if end <= start:
            raise HTTPException(status_code=400, detail="end_at must be greater than start_at")
        month_key = f"{start.year:04d}-{start.month:02d}"
    else:
        start, end, month_key = _month_bounds(month)

    rows = db.execute(
        _task_with_link_meta_stmt()
        .where(DashboardTask.scheduled_at >= start, DashboardTask.scheduled_at < end)
        .order_by(DashboardTask.scheduled_at.asc(), DashboardTask.created_at.asc())
    ).all()

    return DashboardTaskListResponse(
        month=month_key,
        items=[
            _to_dashboard_task_item(
                row[0],
                linked_document_title=row.linked_document_title,
                linked_file_name=row.linked_file_name,
            )
            for row in rows
        ],
        generated_at=_now(),
    )


@router.get("/dashboard/tasks/{task_id}", response_model=DashboardTaskItem)
def get_dashboard_task(
    task_id: UUID,
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DashboardTaskItem:
    row = db.execute(_task_with_link_meta_stmt().where(DashboardTask.id == task_id).limit(1)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return _to_dashboard_task_item(
        row[0],
        linked_document_title=row.linked_document_title,
        linked_file_name=row.linked_file_name,
    )


@router.post("/dashboard/tasks", response_model=DashboardTaskItem)
def create_dashboard_task(
    req: DashboardTaskCreateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DashboardTaskItem:
    settings_row = _get_task_settings_row(db)
    allowed_categories = _normalize_categories(settings_row.categories_json)
    category = req.category.strip()
    if category not in allowed_categories:
        raise HTTPException(status_code=400, detail="unknown task category")

    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    allow_all_day = bool(settings_row.allow_all_day)
    all_day = bool(req.all_day) if allow_all_day else False
    scheduled_at = _to_utc(req.scheduled_at)
    ended_at = _normalize_task_ended_at(scheduled_at=scheduled_at, ended_at=req.ended_at, all_day=all_day)
    linked_document_id, linked_file_id = _normalize_task_linked_file(db, req.linked_document_id, req.linked_file_id)

    task = DashboardTask(
        kind=_derive_task_kind(category),
        category=category,
        title=title,
        scheduled_at=scheduled_at,
        ended_at=ended_at,
        all_day=all_day,
        location=req.location.strip() if settings_row.use_location and req.location and req.location.strip() else None,
        comment=req.comment.strip() if settings_row.use_comment and req.comment and req.comment.strip() else None,
        linked_document_id=linked_document_id,
        linked_file_id=linked_file_id,
        created_by=current_user.id,
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    row = db.execute(_task_with_link_meta_stmt().where(DashboardTask.id == task.id).limit(1)).first()
    if row is None:
        raise HTTPException(status_code=500, detail="task lookup failed after create")
    return _to_dashboard_task_item(
        row[0],
        linked_document_title=row.linked_document_title,
        linked_file_name=row.linked_file_name,
    )


@router.patch("/dashboard/tasks/{task_id}", response_model=DashboardTaskItem)
def update_dashboard_task(
    task_id: UUID,
    req: DashboardTaskUpdateRequest,
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DashboardTaskItem:
    task = db.get(DashboardTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")

    settings_row = _get_task_settings_row(db)
    allowed_categories = _normalize_categories(settings_row.categories_json)
    category = req.category.strip()
    if category not in allowed_categories:
        raise HTTPException(status_code=400, detail="unknown task category")

    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    allow_all_day = bool(settings_row.allow_all_day)
    all_day = bool(req.all_day) if allow_all_day else False
    scheduled_at = _to_utc(req.scheduled_at)
    ended_at = _normalize_task_ended_at(scheduled_at=scheduled_at, ended_at=req.ended_at, all_day=all_day)
    linked_document_id, linked_file_id = _normalize_task_linked_file(db, req.linked_document_id, req.linked_file_id)

    task.category = category
    task.kind = _derive_task_kind(category)
    task.title = title
    task.scheduled_at = scheduled_at
    task.ended_at = ended_at
    task.all_day = all_day
    task.location = req.location.strip() if settings_row.use_location and req.location and req.location.strip() else None
    task.comment = req.comment.strip() if settings_row.use_comment and req.comment and req.comment.strip() else None
    task.linked_document_id = linked_document_id
    task.linked_file_id = linked_file_id
    task.updated_at = _now()
    db.add(task)
    db.commit()
    db.refresh(task)

    row = db.execute(_task_with_link_meta_stmt().where(DashboardTask.id == task.id).limit(1)).first()
    if row is None:
        raise HTTPException(status_code=500, detail="task lookup failed after update")
    return _to_dashboard_task_item(
        row[0],
        linked_document_title=row.linked_document_title,
        linked_file_name=row.linked_file_name,
    )


@router.get("/dashboard/task-settings", response_model=DashboardTaskSettingsResponse)
def get_dashboard_task_settings(
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DashboardTaskSettingsResponse:
    row = _get_task_settings_row(db)
    categories = _normalize_categories(row.categories_json)
    holidays = _normalize_holidays(row.holidays_json)
    list_range_past_days = _normalize_task_list_range_past_days(row.list_range_past_days)
    list_range_future_months = _normalize_task_list_range_future_months(row.list_range_future_months)
    return DashboardTaskSettingsResponse(
        categories=categories,
        category_colors=_normalize_category_colors(row.category_colors_json, categories),
        holidays=holidays,
        allow_all_day=bool(row.allow_all_day),
        use_location=bool(row.use_location),
        use_comment=bool(row.use_comment),
        default_time=row.default_time if _is_valid_time_hhmm(row.default_time) else "09:00",
        list_range_past_days=list_range_past_days,
        list_range_future_months=list_range_future_months,
        generated_at=_now(),
    )


@router.put("/dashboard/task-settings", response_model=DashboardTaskSettingsResponse)
def update_dashboard_task_settings(
    req: DashboardTaskSettingsUpdateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN, UserRole.EDITOR)),
    db: Session = Depends(get_db),
) -> DashboardTaskSettingsResponse:
    categories = _normalize_categories(req.categories)
    category_colors = _normalize_category_colors(req.category_colors, categories)
    holidays = _normalize_holidays(req.holidays)
    default_time = req.default_time.strip()
    list_range_past_days = _normalize_task_list_range_past_days(req.list_range_past_days)
    list_range_future_months = _normalize_task_list_range_future_months(req.list_range_future_months)
    if not _is_valid_time_hhmm(default_time):
        raise HTTPException(status_code=400, detail="default_time must be HH:MM")

    row = _get_task_settings_row(db)
    row.categories_json = categories
    row.category_colors_json = category_colors
    row.holidays_json = holidays
    row.allow_all_day = bool(req.allow_all_day)
    row.use_location = bool(req.use_location)
    row.use_comment = bool(req.use_comment)
    row.default_time = default_time
    row.list_range_past_days = list_range_past_days
    row.list_range_future_months = list_range_future_months
    row.created_by = current_user.id
    row.updated_at = _now()
    db.add(row)
    db.commit()
    db.refresh(row)

    return DashboardTaskSettingsResponse(
        categories=categories,
        category_colors=category_colors,
        holidays=holidays,
        allow_all_day=bool(row.allow_all_day),
        use_location=bool(row.use_location),
        use_comment=bool(row.use_comment),
        default_time=row.default_time,
        list_range_past_days=list_range_past_days,
        list_range_future_months=list_range_future_months,
        generated_at=_now(),
    )


@router.delete("/dashboard/tasks/{task_id}", status_code=204)
def delete_dashboard_task(
    task_id: UUID,
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> None:
    row = db.get(DashboardTask, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    db.delete(row)
    db.commit()
