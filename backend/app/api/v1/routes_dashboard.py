from datetime import datetime, timedelta, timezone
import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, literal, select
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, require_roles
from app.db.models import (
    Category,
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
DEFAULT_CATEGORY_COLORS = {
    "할일": "#059669",
    "회의": "#0284C7",
}
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


def _get_task_settings_row(db: Session) -> DashboardTaskSetting:
    row = db.get(DashboardTaskSetting, "default")
    if row is None:
        row = DashboardTaskSetting(
            scope="default",
            categories_json=DEFAULT_TASK_CATEGORIES,
            category_colors_json=DEFAULT_CATEGORY_COLORS,
            allow_all_day=True,
            use_location=True,
            use_comment=True,
            default_time="09:00",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _derive_task_kind(category: str) -> DashboardTaskKind:
    if "회의" in category.lower():
        return DashboardTaskKind.MEETING
    return DashboardTaskKind.TODO


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
        .order_by(DocumentFile.created_at.asc(), File.original_filename.asc())
        .limit(1)
        .scalar_subquery()
    )

    first_file_extension = (
        select(File.extension)
        .select_from(DocumentFile)
        .join(File, File.id == DocumentFile.file_id)
        .where(DocumentFile.document_id == Document.id)
        .order_by(DocumentFile.created_at.asc(), File.original_filename.asc())
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


@router.get("/dashboard/tasks", response_model=DashboardTaskListResponse)
def get_dashboard_tasks(
    month: str | None = Query(None, description="YYYY-MM"),
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DashboardTaskListResponse:
    start, end, month_key = _month_bounds(month)
    rows = db.execute(
        select(DashboardTask)
        .where(DashboardTask.scheduled_at >= start, DashboardTask.scheduled_at < end)
        .order_by(DashboardTask.scheduled_at.asc(), DashboardTask.created_at.asc())
    ).scalars().all()

    return DashboardTaskListResponse(
        month=month_key,
        items=[
            DashboardTaskItem(
                id=row.id,
                category=row.category,
                title=row.title,
                scheduled_at=row.scheduled_at,
                all_day=row.all_day,
                location=row.location,
                comment=row.comment,
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
    row = db.get(DashboardTask, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return DashboardTaskItem(
        id=row.id,
        category=row.category,
        title=row.title,
        scheduled_at=row.scheduled_at,
        all_day=row.all_day,
        location=row.location,
        comment=row.comment,
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

    task = DashboardTask(
        kind=_derive_task_kind(category),
        category=category,
        title=title,
        scheduled_at=req.scheduled_at,
        all_day=all_day,
        location=req.location.strip() if settings_row.use_location and req.location and req.location.strip() else None,
        comment=req.comment.strip() if settings_row.use_comment and req.comment and req.comment.strip() else None,
        created_by=current_user.id,
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    return DashboardTaskItem(
        id=task.id,
        category=task.category,
        title=task.title,
        scheduled_at=task.scheduled_at,
        all_day=task.all_day,
        location=task.location,
        comment=task.comment,
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

    task.category = category
    task.kind = _derive_task_kind(category)
    task.title = title
    task.scheduled_at = req.scheduled_at
    task.all_day = all_day
    task.location = req.location.strip() if settings_row.use_location and req.location and req.location.strip() else None
    task.comment = req.comment.strip() if settings_row.use_comment and req.comment and req.comment.strip() else None
    task.updated_at = _now()
    db.add(task)
    db.commit()
    db.refresh(task)

    return DashboardTaskItem(
        id=task.id,
        category=task.category,
        title=task.title,
        scheduled_at=task.scheduled_at,
        all_day=task.all_day,
        location=task.location,
        comment=task.comment,
    )


@router.get("/dashboard/task-settings", response_model=DashboardTaskSettingsResponse)
def get_dashboard_task_settings(
    _: CurrentUser = Depends(require_roles(UserRole.VIEWER, UserRole.REVIEWER, UserRole.EDITOR, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> DashboardTaskSettingsResponse:
    row = _get_task_settings_row(db)
    categories = _normalize_categories(row.categories_json)
    return DashboardTaskSettingsResponse(
        categories=categories,
        category_colors=_normalize_category_colors(row.category_colors_json, categories),
        allow_all_day=bool(row.allow_all_day),
        use_location=bool(row.use_location),
        use_comment=bool(row.use_comment),
        default_time=row.default_time if _is_valid_time_hhmm(row.default_time) else "09:00",
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
    default_time = req.default_time.strip()
    if not _is_valid_time_hhmm(default_time):
        raise HTTPException(status_code=400, detail="default_time must be HH:MM")

    row = _get_task_settings_row(db)
    row.categories_json = categories
    row.category_colors_json = category_colors
    row.allow_all_day = bool(req.allow_all_day)
    row.use_location = bool(req.use_location)
    row.use_comment = bool(req.use_comment)
    row.default_time = default_time
    row.created_by = current_user.id
    row.updated_at = _now()
    db.add(row)
    db.commit()
    db.refresh(row)

    return DashboardTaskSettingsResponse(
        categories=categories,
        category_colors=category_colors,
        allow_all_day=bool(row.allow_all_day),
        use_location=bool(row.use_location),
        use_comment=bool(row.use_comment),
        default_time=row.default_time,
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
