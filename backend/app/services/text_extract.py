"""Lightweight body-text extraction from common document formats.

Used by the ingest pipeline to feed `body_text` into the rule engine
(category classification, date detection, tag inference). Each extractor
is best-effort: any failure returns an empty string and the pipeline
continues without the extra signal.

Designed to read at most the first N characters / pages so very large
files do not block the request.
"""

from __future__ import annotations

import io
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_MAX_CHARS = 32_000
_MAX_PDF_PAGES = 8


def _truncate(text: str) -> str:
    if len(text) <= _MAX_CHARS:
        return text
    return text[:_MAX_CHARS]


def _extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except Exception:  # noqa: BLE001
        return ""
    try:
        reader = PdfReader(str(path))
        chunks: list[str] = []
        for idx, page in enumerate(reader.pages):
            if idx >= _MAX_PDF_PAGES:
                break
            try:
                chunks.append(page.extract_text() or "")
            except Exception:  # noqa: BLE001
                continue
            if sum(len(c) for c in chunks) >= _MAX_CHARS:
                break
        return _truncate("\n".join(chunks))
    except Exception as exc:  # noqa: BLE001
        logger.debug("pdf extract failed for %s: %s", path, exc)
        return ""


def _extract_docx(path: Path) -> str:
    try:
        from docx import Document  # type: ignore
    except Exception:  # noqa: BLE001
        return ""
    try:
        doc = Document(str(path))
        chunks: list[str] = []
        for para in doc.paragraphs:
            text = (para.text or "").strip()
            if text:
                chunks.append(text)
            if sum(len(c) for c in chunks) >= _MAX_CHARS:
                break
        return _truncate("\n".join(chunks))
    except Exception as exc:  # noqa: BLE001
        logger.debug("docx extract failed for %s: %s", path, exc)
        return ""


def _extract_plain_text(path: Path) -> str:
    try:
        with path.open("rb") as fp:
            raw = fp.read(_MAX_CHARS * 2)
    except OSError:
        return ""
    for encoding in ("utf-8", "utf-16", "cp949", "euc-kr", "latin-1"):
        try:
            return _truncate(raw.decode(encoding))
        except UnicodeDecodeError:
            continue
    return ""


def extract_body_text(path: str | Path | None, *, mime_type: str | None, filename: str | None) -> str:
    """Best-effort body text extraction.

    Returns an empty string if the file is missing, unsupported, or extraction fails.
    """
    if not path:
        return ""
    file_path = Path(path)
    if not file_path.exists() or not file_path.is_file():
        return ""

    suffix = (file_path.suffix or Path(filename or "").suffix or "").lower().lstrip(".")
    mime = (mime_type or "").lower()

    if suffix == "pdf" or mime == "application/pdf":
        return _extract_pdf(file_path)

    if suffix in {"docx"} or mime in {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}:
        return _extract_docx(file_path)

    if suffix in {"txt", "md", "markdown", "log", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "rtf"}:
        return _extract_plain_text(file_path)

    if mime.startswith("text/"):
        return _extract_plain_text(file_path)

    return ""
