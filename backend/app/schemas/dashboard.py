from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.db.models import ReviewStatus


class DashboardCategoryCount(BaseModel):
    category: str
    count: int


class DashboardErrorCodeCount(BaseModel):
    error_code: str
    count: int


class DashboardRecentDocument(BaseModel):
    id: UUID
    title: str
    category: str
    first_file_id: UUID | None = None
    first_file_extension: str | None = None
    event_date: date | None = None
    ingested_at: datetime
    review_status: ReviewStatus


class DashboardPinnedDocument(BaseModel):
    id: UUID
    title: str
    category: str
    event_date: date | None = None
    ingested_at: datetime
    review_status: ReviewStatus


class DashboardPinnedCategory(BaseModel):
    category: str
    count: int
    documents: list[DashboardPinnedDocument] = Field(default_factory=list)


class DashboardSummaryResponse(BaseModel):
    total_documents: int
    recent_uploads_7d: int
    needs_review_count: int
    failed_jobs_count: int
    retry_scheduled_count: int
    dead_letter_count: int
    failed_error_codes: list[DashboardErrorCodeCount] = Field(default_factory=list)
    categories: list[DashboardCategoryCount] = Field(default_factory=list)
    pinned_by_category: list[DashboardPinnedCategory] = Field(default_factory=list)
    recent_documents: list[DashboardRecentDocument] = Field(default_factory=list)
    generated_at: datetime


class DashboardMilestoneItem(BaseModel):
    id: UUID
    title: str
    start_date: date
    end_date: date | None = None
    description: str = ""
    color: str | None = None
    created_at: datetime
    updated_at: datetime


class DashboardMilestoneListResponse(BaseModel):
    start_year: int
    end_year: int
    items: list[DashboardMilestoneItem] = Field(default_factory=list)
    generated_at: datetime


class DashboardMilestoneCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    start_date: date
    end_date: date | None = None
    description: str = Field(default="", max_length=2000)
    color: str | None = Field(default=None, min_length=7, max_length=7)


class DashboardMilestoneUpdateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    start_date: date
    end_date: date | None = None
    description: str = Field(default="", max_length=2000)
    color: str | None = Field(default=None, min_length=7, max_length=7)


class DashboardTaskItem(BaseModel):
    id: UUID
    category: str
    title: str
    scheduled_at: datetime
    ended_at: datetime | None = None
    all_day: bool = False
    location: str | None = None
    comment: str | None = None
    linked_document_id: UUID | None = None
    linked_document_title: str | None = None
    linked_file_id: UUID | None = None
    linked_file_name: str | None = None
    linked_file_download_path: str | None = None


class DashboardTaskListResponse(BaseModel):
    month: str
    items: list[DashboardTaskItem] = Field(default_factory=list)
    generated_at: datetime


class DashboardTaskCreateRequest(BaseModel):
    category: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=220)
    scheduled_at: datetime
    ended_at: datetime | None = None
    all_day: bool = False
    location: str | None = Field(default=None, max_length=220)
    comment: str | None = Field(default=None, max_length=300)
    linked_document_id: UUID | None = None
    linked_file_id: UUID | None = None


class DashboardTaskUpdateRequest(BaseModel):
    category: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=220)
    scheduled_at: datetime
    ended_at: datetime | None = None
    all_day: bool = False
    location: str | None = Field(default=None, max_length=220)
    comment: str | None = Field(default=None, max_length=300)
    linked_document_id: UUID | None = None
    linked_file_id: UUID | None = None


class DashboardTaskSettingsResponse(BaseModel):
    categories: list[str] = Field(default_factory=lambda: ["할일", "회의"])
    category_colors: dict[str, str] = Field(default_factory=dict)
    holidays: dict[str, str] = Field(default_factory=dict)
    allow_all_day: bool = True
    use_location: bool = True
    use_comment: bool = True
    default_time: str = "09:00"
    list_range_past_days: int = 7
    list_range_future_months: int = 2
    generated_at: datetime


class DashboardTaskSettingsUpdateRequest(BaseModel):
    categories: list[str] = Field(default_factory=list, max_length=30)
    category_colors: dict[str, str] = Field(default_factory=dict)
    holidays: dict[str, str] = Field(default_factory=dict)
    allow_all_day: bool = True
    use_location: bool = True
    use_comment: bool = True
    default_time: str = Field(default="09:00", min_length=5, max_length=5)
    list_range_past_days: int = Field(default=7, ge=0, le=365)
    list_range_future_months: int = Field(default=2, ge=0, le=24)
