from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.db.models import IngestState, SourceType


class IngestAcceptedResponse(BaseModel):
    job_id: UUID
    state: IngestState
    source: SourceType
    source_ref: str | None
    queued_at: datetime


class IngestJobStatusResponse(BaseModel):
    job_id: UUID
    state: IngestState
    source: SourceType
    source_ref: str | None = None
    document_id: UUID | None = None
    attempt_count: int
    max_attempts: int
    last_error_code: str | None = None
    last_error_message: str | None = None
    received_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    is_terminal: bool
    success: bool


class IngestBatchRejectedItem(BaseModel):
    index: int
    filename: str
    source_ref: str | None = None
    error: str


class IngestBatchAcceptedResponse(BaseModel):
    total_files: int
    accepted_count: int
    rejected_count: int
    accepted: list[IngestAcceptedResponse] = Field(default_factory=list)
    rejected: list[IngestBatchRejectedItem] = Field(default_factory=list)


class ManualIngestPayload(BaseModel):
    source: SourceType
    caption: str | None = None
    title: str | None = None
    description: str | None = None
