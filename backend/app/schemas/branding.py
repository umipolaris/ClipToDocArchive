from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class BrandingLogoResponse(BaseModel):
    exists: bool = False
    logo_file_id: UUID | None = None
    image_url: str | None = None
    filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    updated_at: datetime | None = None


class BrandingLogoDeleteResponse(BaseModel):
    status: str
    removed: bool
    previous_file_id: UUID | None = None

