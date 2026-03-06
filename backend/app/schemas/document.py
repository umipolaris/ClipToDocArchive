from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.db.models import ReviewStatus


class DocumentListItem(BaseModel):
    id: UUID
    title: str
    description: str
    category: str | None = None
    event_date: date | None = None
    ingested_at: datetime
    is_pinned: bool = False
    pinned_at: datetime | None = None
    last_modified_at: datetime | None = None
    tags: list[str] = Field(default_factory=list)
    file_count: int = 0
    comment_count: int = 0
    files: list["DocumentListFileItem"] = Field(default_factory=list)
    review_status: ReviewStatus
    review_reasons: list[str] = Field(default_factory=list)


class DocumentListResponse(BaseModel):
    items: list[DocumentListItem]
    page: int
    size: int
    total: int


class DocumentListFileItem(BaseModel):
    id: UUID
    original_filename: str
    download_path: str


class DocumentFileItem(BaseModel):
    id: UUID
    original_filename: str
    mime_type: str
    size_bytes: int
    checksum_sha256: str
    storage_backend: str
    download_path: str


class DocumentVersionItem(BaseModel):
    version_no: int
    changed_at: datetime
    change_reason: str
    title: str
    event_date: date | None = None


class DocumentVersionDiffResponse(BaseModel):
    document_id: UUID
    from_version_no: int
    to_version_no: int
    changed_fields: list[str] = Field(default_factory=list)
    title_from: str
    title_to: str
    description_diff: str
    summary_diff: str
    tags_from: list[str] = Field(default_factory=list)
    tags_to: list[str] = Field(default_factory=list)
    event_date_from: date | None = None
    event_date_to: date | None = None
    category_id_from: UUID | None = None
    category_id_to: UUID | None = None


class DocumentVersionSnapshotResponse(BaseModel):
    document_id: UUID
    version_no: int
    changed_at: datetime
    change_reason: str
    title: str
    description: str
    summary: str
    category_id: UUID | None = None
    category: str | None = None
    event_date: date | None = None
    tags: list[str] = Field(default_factory=list)


class DocumentDetailResponse(BaseModel):

    id: UUID
    source: str
    source_ref: str | None
    title: str
    description: str
    caption_raw: str
    summary: str
    category_id: UUID | None
    category: str | None = None
    categories: list[str] = Field(default_factory=list)
    event_date: date | None
    ingested_at: datetime
    is_pinned: bool = False
    pinned_at: datetime | None = None
    review_status: ReviewStatus
    review_reasons: list[str]
    current_version_no: int = 1
    tags: list[str]
    files: list[DocumentFileItem]
    versions: list[DocumentVersionItem]


class DocumentHistoryItem(BaseModel):
    id: int
    action: str
    actor_username: str | None = None
    source: str | None = None
    source_ref: str | None = None
    created_at: datetime
    before_json: dict | None = None
    after_json: dict | None = None
    masked_fields: list[str] = Field(default_factory=list)


class DocumentHistoryResponse(BaseModel):
    items: list[DocumentHistoryItem]
    page: int
    size: int
    total: int


class DocumentCommentItem(BaseModel):
    id: UUID
    document_id: UUID
    content: str
    created_at: datetime
    updated_at: datetime
    created_by: UUID | None = None
    created_by_username: str | None = None
    is_edited: bool = False
    can_edit: bool = False
    can_delete: bool = False


class DocumentCommentListResponse(BaseModel):
    items: list[DocumentCommentItem] = Field(default_factory=list)


class DocumentCommentCreateRequest(BaseModel):
    content: str


class DocumentCommentUpdateRequest(BaseModel):
    content: str


class DocumentCommentDeleteResponse(BaseModel):
    status: str
    document_id: UUID
    comment_id: UUID


class DocumentUpdateRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    summary: str | None = None
    category_id: UUID | None = None
    category_name: str | None = None
    category_names: list[str] | None = None
    event_date: date | None = None
    is_pinned: bool | None = None
    tags: list[str] | None = None
    review_status: ReviewStatus | None = None


class ReclassifyRequest(BaseModel):
    rule_version_id: UUID
    dry_run: bool = False


class ManualPostCreateRequest(BaseModel):
    title: str
    description: str = ""
    caption_raw: str | None = None
    summary: str | None = None
    category_id: UUID | None = None
    category_name: str | None = None
    category_names: list[str] = Field(default_factory=list)
    event_date: date | None = None
    is_pinned: bool = False
    tags: list[str] = Field(default_factory=list)
    review_status: ReviewStatus = ReviewStatus.NONE


class ManualPostCategoryOptionsResponse(BaseModel):
    categories: list[str] = Field(default_factory=list)


class DocumentDeleteResponse(BaseModel):
    status: str
    document_id: UUID
    deleted_file_links: int
    deleted_orphan_files: int


class TimelineBucket(BaseModel):
    bucket: str
    count: int


class TimelineResponse(BaseModel):
    scale: str
    buckets: list[TimelineBucket]


class ReviewQueueItem(BaseModel):
    document_id: UUID
    reasons: list[str]
    title: str
    source_ref: str | None
    suggested_actions: list[str]


class ReviewQueueResponse(BaseModel):
    items: list[ReviewQueueItem]
    total: int


class ReviewQueueUpdateRequest(BaseModel):
    approve: bool = False
    category_id: UUID | None = None
    category_name: str | None = None
    event_date: date | None = None
    tags: list[str] | None = None
    reason_remove: list[str] = Field(default_factory=list)
    note: str | None = None


class ReviewQueueUpdateResult(BaseModel):
    document_id: UUID
    updated: bool
    review_status: ReviewStatus
    review_reasons: list[str]


class ReviewQueueBulkRequest(BaseModel):
    document_ids: list[UUID]
    update: ReviewQueueUpdateRequest


class ReviewQueueBulkResponse(BaseModel):
    requested: int
    updated: int
    not_found: list[UUID]
    results: list[ReviewQueueUpdateResult]
