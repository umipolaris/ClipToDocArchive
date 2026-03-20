from uuid import uuid4

from app.api.v1.routes_dashboard import _task_file_download_path
from app.api.v1.routes_documents import (
    _document_file_download_path,
    _normalize_document_file_display_name,
)


def test_normalize_document_file_display_name_prefers_document_specific_name():
    out = _normalize_document_file_display_name(
        "별첨 4-1. 입자 가속 기술(Particle acceleration technology)_rev1.pdf",
        "Particle acceleration technology_Rev.3.pdf",
    )

    assert out == "별첨 4-1. 입자 가속 기술(Particle acceleration technology)_rev1.pdf"


def test_normalize_document_file_display_name_falls_back_to_stored_name():
    out = _normalize_document_file_display_name(
        "   ",
        "/tmp/uploads/Particle acceleration technology_Rev.3.pdf",
    )

    assert out == "Particle acceleration technology_Rev.3.pdf"


def test_document_scoped_download_paths_use_document_context():
    document_id = uuid4()
    file_id = uuid4()

    assert _document_file_download_path(document_id, file_id) == f"/documents/{document_id}/files/{file_id}/download"
    assert _task_file_download_path(document_id, file_id) == f"/documents/{document_id}/files/{file_id}/download"
