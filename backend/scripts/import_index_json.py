#!/usr/bin/env python3
"""Import legacy index.json data into the archive schema.

Examples:
  python scripts/import_index_json.py \
    --index-json /legacy/data/index.json \
    --legacy-root /legacy/data \
    --source-mode auto \
    --source-ref-prefix legacy \
    --report /tmp/import_report.txt \
    --json-report /tmp/import_report.json

  python scripts/import_index_json.py \
    --index-json /legacy/data/index.json \
    --dry-run \
    --missing-file document-only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.config import get_settings
from app.db.models import (
    Category,
    Document,
    DocumentFile,
    DocumentTag,
    DocumentVersion,
    File,
    ReviewStatus,
    RuleVersion,
    SourceType,
    Tag,
    User,
)
from app.db.session import SessionLocal
from app.services.caption_parser import parse_caption, sanitize_filename
from app.services.dedupe_service import find_by_checksum
from app.services.rule_engine import RuleInput, apply_rules
from app.services.storage_disk import put_file as put_file_disk
from app.services.summary_service import build_summary

UNKNOWN_SOURCE_FALLBACK = SourceType.manual
DEFAULT_RULES = {"default_category": "기타", "category_rules": []}
MAX_DETAIL_ROWS = 2000


@dataclass
class ImportItemResult:
    index: int
    item_id: str
    source: str
    source_ref: str
    status: str
    message: str
    title: str = ""
    document_id: str | None = None
    file_id: str | None = None


@dataclass
class ImportReport:
    started_at: str
    finished_at: str
    args: dict[str, Any]
    total_items: int = 0
    imported: int = 0
    skipped_existing: int = 0
    skipped_missing_file: int = 0
    skipped_duplicate_input: int = 0
    failed: int = 0
    unknown_source_fallback: int = 0
    results: list[ImportItemResult] = field(default_factory=list)

    def add(self, item: ImportItemResult) -> None:
        self.results.append(item)
        if item.status == "imported":
            self.imported += 1
        elif item.status == "skipped_existing":
            self.skipped_existing += 1
        elif item.status == "skipped_missing_file":
            self.skipped_missing_file += 1
        elif item.status == "skipped_duplicate_input":
            self.skipped_duplicate_input += 1
        elif item.status == "failed":
            self.failed += 1

    @property
    def has_failures(self) -> bool:
        return self.failed > 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "args": self.args,
            "summary": {
                "total_items": self.total_items,
                "imported": self.imported,
                "skipped_existing": self.skipped_existing,
                "skipped_missing_file": self.skipped_missing_file,
                "skipped_duplicate_input": self.skipped_duplicate_input,
                "failed": self.failed,
                "unknown_source_fallback": self.unknown_source_fallback,
            },
            "results": [asdict(row) for row in self.results],
        }

    def to_text(self) -> str:
        lines: list[str] = []
        lines.append("# Legacy Import Report")
        lines.append(f"- started_at: {self.started_at}")
        lines.append(f"- finished_at: {self.finished_at}")
        lines.append(f"- total_items: {self.total_items}")
        lines.append(f"- imported: {self.imported}")
        lines.append(f"- skipped_existing: {self.skipped_existing}")
        lines.append(f"- skipped_missing_file: {self.skipped_missing_file}")
        lines.append(f"- skipped_duplicate_input: {self.skipped_duplicate_input}")
        lines.append(f"- failed: {self.failed}")
        lines.append(f"- unknown_source_fallback: {self.unknown_source_fallback}")
        lines.append("")
        lines.append("## Details")

        if not self.results:
            lines.append("- no rows")
            return "\n".join(lines) + "\n"

        for row in self.results[:MAX_DETAIL_ROWS]:
            lines.append(
                f"- [{row.status}] idx={row.index} item_id={row.item_id} "
                f"source={row.source} source_ref={row.source_ref} "
                f"doc={row.document_id or '-'} file={row.file_id or '-'} "
                f"title={row.title!r} msg={row.message}"
            )
        if len(self.results) > MAX_DETAIL_ROWS:
            lines.append(f"- ... truncated {len(self.results) - MAX_DETAIL_ROWS} rows")

        return "\n".join(lines) + "\n"


@dataclass
class LegacyRecord:
    index: int
    item_id: str
    source: SourceType
    source_ref: str
    title: str
    description: str
    summary: str
    category: str | None
    event_date_text: str | None
    created_at: datetime
    original_filename: str
    stored_path: str | None
    tags: list[str]
    caption_raw: str | None
    raw: dict[str, Any]


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def now_utc() -> datetime:
    return datetime.now(tz=timezone.utc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import legacy index.json into archive database")
    parser.add_argument("--index-json", required=True, help="legacy index.json path")
    parser.add_argument("--legacy-root", default="", help="legacy root directory (for relative storedPath)")
    parser.add_argument("--source-mode", choices=["auto", "telegram", "wiki", "manual", "api"], default="auto")
    parser.add_argument("--source-ref-prefix", default="legacy", help="source_ref prefix when absent in legacy row")
    parser.add_argument("--created-by-username", default="", help="created_by user lookup (optional)")
    parser.add_argument("--missing-file", choices=["skip", "fail", "document-only"], default="skip")
    parser.add_argument("--max-items", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--stop-on-error", action="store_true")
    parser.add_argument("--report", default="", help="text report file")
    parser.add_argument("--json-report", default="", help="json report file")
    return parser.parse_args()


def _first_non_empty(raw: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = raw.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def _slugify(text: str) -> str:
    return text.strip().lower().replace(" ", "-")


def _normalize_tags(raw_tags: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for raw in raw_tags:
        value = str(raw).strip()
        if not value:
            continue
        key = _slugify(value)
        if key in seen:
            continue
        seen.add(key)
        result.append(value)
    return result


def _parse_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return _normalize_tags([str(v).strip() for v in value if str(v).strip()])
    text = str(value).strip()
    if not text:
        return []
    parts = [part.strip() for part in text.replace(";", ",").replace("\n", ",").split(",")]
    return _normalize_tags([part for part in parts if part])


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None

    candidates = [text, text.replace("Z", "+00:00")]
    for candidate in candidates:
        try:
            parsed = datetime.fromisoformat(candidate)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except ValueError:
            continue
    return None


def _resolve_source(raw_source: str | None, source_mode: str) -> tuple[SourceType, bool]:
    if source_mode != "auto":
        return SourceType(source_mode), False

    lowered = (raw_source or "").strip().lower()
    source_map = {
        "telegram": SourceType.telegram,
        "wiki": SourceType.wiki,
        "manual": SourceType.manual,
        "api": SourceType.api,
    }
    if lowered in source_map:
        return source_map[lowered], False
    return UNKNOWN_SOURCE_FALLBACK, bool(lowered)


def _build_source_ref(raw: dict[str, Any], *, source_ref_prefix: str, item_id: str) -> str:
    source_ref = _first_non_empty(raw, ["source_ref", "sourceRef"])
    if source_ref:
        return source_ref

    message_id = _first_non_empty(raw, ["message_id", "messageId", "msg_id", "msgId"])
    if message_id:
        return f"msg:{message_id}"

    prefix = source_ref_prefix.strip() or "legacy"
    return f"{prefix}:{item_id}"


def _load_legacy_rows(index_json_path: Path) -> list[dict[str, Any]]:
    raw = json.loads(index_json_path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    if not isinstance(raw, dict):
        raise ValueError("index json must be object or array")

    for key in ("items", "documents", "data"):
        rows = raw.get(key)
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


def _resolve_legacy_file_path(
    stored_path: str | None,
    *,
    index_json_path: Path,
    legacy_root: Path,
) -> tuple[Path | None, list[Path]]:
    candidates: list[Path] = []
    if not stored_path:
        return None, candidates

    normalized = stored_path.replace("\\", "/").strip()
    if not normalized:
        return None, candidates

    path_obj = Path(normalized)
    if path_obj.is_absolute():
        candidates.append(path_obj)
    else:
        candidates.append(index_json_path.parent / normalized)
        candidates.append(legacy_root / normalized)
        candidates.append(index_json_path.parent / path_obj.name)
        candidates.append(legacy_root / path_obj.name)
        candidates.append(index_json_path.parent / "files" / path_obj.name)
        candidates.append(legacy_root / "files" / path_obj.name)
        marker = "automation/data/"
        if marker in normalized:
            trimmed = normalized.split(marker, maxsplit=1)[1]
            candidates.append(index_json_path.parent / trimmed)
            candidates.append(legacy_root / trimmed)

    deduped: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path.resolve() if path.exists() else path)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(path)

    for path in deduped:
        if path.exists() and path.is_file():
            return path, deduped
    return None, deduped


def _storage_key(checksum_sha256: str, extension: str | None) -> str:
    ext = (extension or "bin").lower().lstrip(".")
    return f"{checksum_sha256[0:2]}/{checksum_sha256[2:4]}/{checksum_sha256}.{ext}"


def _upsert_category(db: Session, category_name: str | None, created_by: UUID | None) -> Category | None:
    if not category_name:
        return None
    normalized = category_name.strip()
    if not normalized:
        return None

    slug = _slugify(normalized)
    existing = db.execute(select(Category).where(Category.slug == slug)).scalar_one_or_none()
    if existing:
        return existing

    row = Category(name=normalized, slug=slug, is_active=True, created_by=created_by)
    db.add(row)
    db.flush()
    return row


def _upsert_tags(db: Session, tag_names: list[str], created_by: UUID | None) -> list[Tag]:
    rows: list[Tag] = []
    seen: set[str] = set()
    for raw in tag_names:
        name = raw.strip()
        if not name:
            continue
        slug = _slugify(name)
        if slug in seen:
            continue
        seen.add(slug)

        existing = db.execute(select(Tag).where(Tag.slug == slug)).scalar_one_or_none()
        if existing:
            rows.append(existing)
            continue

        tag = Tag(name=name, slug=slug, created_by=created_by)
        db.add(tag)
        db.flush()
        rows.append(tag)
    return rows


def _get_active_rules(db: Session) -> dict:
    row = (
        db.execute(
            select(RuleVersion)
            .where(RuleVersion.is_active.is_(True))
            .order_by(RuleVersion.published_at.desc().nulls_last(), RuleVersion.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    return row.rules_json if row else DEFAULT_RULES


def _resolve_created_by_user_id(username: str) -> UUID | None:
    normalized = username.strip()
    if not normalized:
        return None
    with SessionLocal() as db:
        user = db.execute(select(User).where(User.username == normalized)).scalar_one_or_none()
        if not user:
            raise SystemExit(f"created_by username not found: {normalized}")
        return user.id


def _find_existing_document(db: Session, source: SourceType, source_ref: str) -> Document | None:
    return (
        db.execute(
            select(Document)
            .where(Document.source == source, Document.source_ref == source_ref)
            .limit(1)
        )
        .scalars()
        .first()
    )


def _store_or_reuse_file(
    db: Session,
    *,
    source: SourceType,
    source_ref: str,
    source_path: Path,
    original_filename: str,
    created_by: UUID | None,
    created_at: datetime,
    legacy_metadata: dict[str, Any],
) -> tuple[File, int]:
    content = source_path.read_bytes()
    checksum_sha256 = hashlib.sha256(content).hexdigest()
    existing = find_by_checksum(db, checksum_sha256)
    if existing:
        linked_count = int(
            db.execute(select(func.count(DocumentFile.id)).where(DocumentFile.file_id == existing.id)).scalar_one() or 0
        )
        return existing, linked_count

    mime_type, _ = mimetypes.guess_type(original_filename)
    mime_type = mime_type or "application/octet-stream"
    extension = Path(original_filename).suffix.lstrip(".") or None
    storage_key = _storage_key(checksum_sha256, extension)

    settings = get_settings()
    if settings.storage_backend == "minio":
        from app.services.storage_minio import ensure_bucket, get_minio_client, put_file as put_file_minio

        client = get_minio_client(
            endpoint=settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )
        ensure_bucket(client, settings.storage_bucket)
        put_file_minio(client, settings.storage_bucket, storage_key, content, mime_type)
    else:
        put_file_disk(settings.storage_disk_root, storage_key, content)

    row = File(
        source=source,
        source_ref=source_ref,
        storage_backend=settings.storage_backend,
        bucket=settings.storage_bucket,
        storage_key=storage_key,
        original_filename=original_filename,
        uploaded_filename=original_filename,
        extension=extension,
        checksum_sha256=checksum_sha256,
        mime_type=mime_type,
        size_bytes=len(content),
        metadata_json=legacy_metadata,
        created_at=created_at,
        updated_at=created_at,
        created_by=created_by,
    )
    db.add(row)
    db.flush()
    return row, 0


def _build_caption(
    title: str,
    description: str,
    category: str | None,
    event_date_text: str | None,
    tags: list[str],
    caption_raw: str | None,
) -> str:
    if caption_raw and caption_raw.strip():
        return caption_raw

    lines: list[str] = [title.strip() or "Untitled"]
    if description.strip():
        lines.append(description.strip())
    if category and category.strip():
        lines.append(f"#분류:{category.strip()}")
    if event_date_text and event_date_text.strip():
        lines.append(f"#날짜:{event_date_text.strip()}")
    if tags:
        lines.append(f"#태그:{','.join(tags)}")
    return "\n".join(lines).strip()


def _build_legacy_record(
    index: int,
    raw: dict[str, Any],
    *,
    source_mode: str,
    source_ref_prefix: str,
    report: ImportReport,
) -> LegacyRecord:
    item_id = _first_non_empty(raw, ["id", "item_id", "uuid"]) or f"row-{index}"
    source, fallback_used = _resolve_source(_first_non_empty(raw, ["source"]), source_mode)
    if fallback_used:
        report.unknown_source_fallback += 1

    source_ref = _build_source_ref(raw, source_ref_prefix=source_ref_prefix, item_id=item_id)

    title = _first_non_empty(raw, ["title", "name", "subject"]) or ""
    description = _first_non_empty(raw, ["description", "note", "memo", "message"]) or ""
    summary = _first_non_empty(raw, ["summary"]) or ""
    category = _first_non_empty(raw, ["category", "classification"])
    event_date_text = _first_non_empty(raw, ["date", "event_date", "eventDate"])
    created_at = _parse_datetime(_first_non_empty(raw, ["createdAt", "created_at", "ingested_at"])) or now_utc()
    stored_path = _first_non_empty(raw, ["storedPath", "stored_path", "path", "filePath", "file_path"])
    original_filename = _first_non_empty(raw, ["originalName", "original_filename", "filename"])
    if not original_filename and stored_path:
        original_filename = Path(stored_path.replace("\\", "/")).name
    if not original_filename:
        original_filename = sanitize_filename(title) + ".bin"

    raw_tags: list[str] = []
    raw_tags.extend(_parse_tags(raw.get("tags")))
    raw_tags.extend(_parse_tags(raw.get("tag")))

    caption_raw = _first_non_empty(raw, ["caption", "caption_raw"])
    if not title:
        title = sanitize_filename(original_filename)

    return LegacyRecord(
        index=index,
        item_id=item_id,
        source=source,
        source_ref=source_ref,
        title=title,
        description=description,
        summary=summary,
        category=category,
        event_date_text=event_date_text,
        created_at=created_at,
        original_filename=original_filename,
        stored_path=stored_path,
        tags=_normalize_tags(raw_tags),
        caption_raw=caption_raw,
        raw=raw,
    )


def _create_document_from_legacy(
    db: Session,
    *,
    record: LegacyRecord,
    active_rules: dict,
    created_by: UUID | None,
    index_json_path: Path,
    legacy_root: Path,
    missing_file_policy: str,
) -> ImportItemResult:
    existing = _find_existing_document(db, record.source, record.source_ref)
    if existing:
        return ImportItemResult(
            index=record.index,
            item_id=record.item_id,
            source=record.source.value,
            source_ref=record.source_ref,
            status="skipped_existing",
            message="document already exists by source/source_ref",
            title=existing.title,
            document_id=str(existing.id),
        )

    file_path, attempts = _resolve_legacy_file_path(record.stored_path, index_json_path=index_json_path, legacy_root=legacy_root)
    missing_file = file_path is None
    if missing_file and missing_file_policy == "skip":
        return ImportItemResult(
            index=record.index,
            item_id=record.item_id,
            source=record.source.value,
            source_ref=record.source_ref,
            status="skipped_missing_file",
            message=f"stored file missing; attempts={','.join(str(p) for p in attempts)}",
            title=record.title,
        )
    if missing_file and missing_file_policy == "fail":
        raise FileNotFoundError(f"stored file missing for item_id={record.item_id} attempts={attempts}")

    caption_raw = _build_caption(
        title=record.title,
        description=record.description,
        category=record.category,
        event_date_text=record.event_date_text,
        tags=record.tags,
        caption_raw=record.caption_raw,
    )
    parsed = parse_caption(caption_raw, record.original_filename)

    mime_type = "application/octet-stream"
    if file_path is not None:
        guessed, _ = mimetypes.guess_type(record.original_filename)
        mime_type = guessed or "application/octet-stream"

    rule_out = apply_rules(
        RuleInput(
            caption=parsed,
            title=parsed.title,
            description=parsed.description,
            filename=record.original_filename,
            body_text=parsed.description,
            metadata_date_text=record.event_date_text,
            ingested_at=record.created_at,
        ),
        active_rules,
    )

    merged_tags = _normalize_tags([*record.tags, *parsed.explicit_tags, *rule_out.tags])
    category_name = parsed.explicit_category or record.category or rule_out.category
    event_date = rule_out.event_date
    review_reasons = list(rule_out.review_reasons)

    file_row: File | None = None
    if file_path is not None:
        file_row, linked_count = _store_or_reuse_file(
            db,
            source=record.source,
            source_ref=record.source_ref,
            source_path=file_path,
            original_filename=record.original_filename,
            created_by=created_by,
            created_at=record.created_at,
            legacy_metadata={
                "legacy_item_id": record.item_id,
                "legacy_stored_path": record.stored_path,
            },
        )
        if linked_count > 0 and "DUPLICATE_SUSPECT" not in review_reasons:
            review_reasons.append("DUPLICATE_SUSPECT")
    else:
        if "LEGACY_FILE_MISSING" not in review_reasons:
            review_reasons.append("LEGACY_FILE_MISSING")

    summary = record.summary.strip()
    if not summary:
        summary = build_summary(parsed, filename=record.original_filename, mime_type=mime_type)

    category_row = _upsert_category(db, category_name, created_by)
    tag_rows = _upsert_tags(db, merged_tags, created_by)
    review_status = ReviewStatus.NEEDS_REVIEW if review_reasons else ReviewStatus.NONE

    title = parsed.title.strip() or sanitize_filename(record.original_filename)
    title = title[:300]

    doc = Document(
        source=record.source,
        source_ref=record.source_ref,
        title=title,
        description=parsed.description,
        caption_raw=parsed.caption_raw,
        summary=summary,
        category_id=category_row.id if category_row else None,
        event_date=event_date,
        ingested_at=record.created_at,
        review_status=review_status,
        review_reasons=review_reasons,
        current_version_no=1,
        created_at=record.created_at,
        updated_at=record.created_at,
        created_by=created_by,
    )
    db.add(doc)
    db.flush()

    if file_row is not None:
        db.add(
            DocumentFile(
                document_id=doc.id,
                file_id=file_row.id,
                display_filename=record.original_filename,
                is_primary=True,
                created_at=record.created_at,
                updated_at=record.created_at,
                created_by=created_by,
            )
        )

    for tag in tag_rows:
        db.add(DocumentTag(document_id=doc.id, tag_id=tag.id, created_by=created_by))

    db.add(
        DocumentVersion(
            document_id=doc.id,
            version_no=1,
            title=doc.title,
            description=doc.description,
            summary=doc.summary,
            category_id=doc.category_id,
            event_date=doc.event_date,
            tags_snapshot=[tag.name for tag in tag_rows],
            change_reason="legacy_import",
            changed_at=record.created_at,
            created_at=record.created_at,
            updated_at=record.created_at,
            created_by=created_by,
        )
    )

    db.execute(
        update(Document)
        .where(Document.id == doc.id)
        .values(
            search_vector=func.to_tsvector(
                "simple",
                func.concat_ws(" ", Document.title, Document.description, Document.summary, Document.caption_raw),
            )
        )
    )
    db.flush()

    return ImportItemResult(
        index=record.index,
        item_id=record.item_id,
        source=record.source.value,
        source_ref=record.source_ref,
        status="imported",
        message="ok",
        title=doc.title,
        document_id=str(doc.id),
        file_id=str(file_row.id) if file_row else None,
    )


def _write_report(report: ImportReport, path_str: str, as_json: bool) -> None:
    if not path_str:
        return
    path = Path(path_str)
    path.parent.mkdir(parents=True, exist_ok=True)
    if as_json:
        path.write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        path.write_text(report.to_text(), encoding="utf-8")


def _print_summary(report: ImportReport) -> None:
    print(
        "import summary "
        f"total={report.total_items} imported={report.imported} "
        f"skipped_existing={report.skipped_existing} "
        f"skipped_missing_file={report.skipped_missing_file} "
        f"skipped_duplicate_input={report.skipped_duplicate_input} "
        f"failed={report.failed} "
        f"unknown_source_fallback={report.unknown_source_fallback}"
    )


def main() -> None:
    args = parse_args()
    index_json_path = Path(args.index_json).expanduser().resolve()
    if not index_json_path.exists():
        raise SystemExit(f"index json not found: {index_json_path}")

    legacy_root = Path(args.legacy_root).expanduser().resolve() if args.legacy_root else index_json_path.parent
    rows = _load_legacy_rows(index_json_path)
    if args.max_items is not None:
        rows = rows[: args.max_items]

    created_by = _resolve_created_by_user_id(args.created_by_username)
    with SessionLocal() as db:
        active_rules = _get_active_rules(db)

    report = ImportReport(
        started_at=now_iso(),
        finished_at="",
        args={
            "index_json": str(index_json_path),
            "legacy_root": str(legacy_root),
            "source_mode": args.source_mode,
            "source_ref_prefix": args.source_ref_prefix,
            "created_by_username": args.created_by_username,
            "missing_file": args.missing_file,
            "max_items": args.max_items,
            "dry_run": args.dry_run,
            "stop_on_error": args.stop_on_error,
        },
        total_items=len(rows),
    )

    seen_run_keys: set[tuple[str, str]] = set()

    for idx, raw in enumerate(rows, start=1):
        if not isinstance(raw, dict):
            report.add(
                ImportItemResult(
                    index=idx,
                    item_id=f"row-{idx}",
                    source="manual",
                    source_ref=f"{args.source_ref_prefix}:row-{idx}",
                    status="failed",
                    message="row is not object",
                )
            )
            if args.stop_on_error:
                break
            continue

        record = _build_legacy_record(
            idx,
            raw,
            source_mode=args.source_mode,
            source_ref_prefix=args.source_ref_prefix,
            report=report,
        )
        run_key = (record.source.value, record.source_ref)
        if run_key in seen_run_keys:
            report.add(
                ImportItemResult(
                    index=record.index,
                    item_id=record.item_id,
                    source=record.source.value,
                    source_ref=record.source_ref,
                    status="skipped_duplicate_input",
                    message="duplicate source/source_ref in input rows",
                    title=record.title,
                )
            )
            continue

        try:
            with SessionLocal() as db:
                result = _create_document_from_legacy(
                    db,
                    record=record,
                    active_rules=active_rules,
                    created_by=created_by,
                    index_json_path=index_json_path,
                    legacy_root=legacy_root,
                    missing_file_policy=args.missing_file,
                )
                if args.dry_run:
                    db.rollback()
                else:
                    db.commit()
            seen_run_keys.add(run_key)
            report.add(result)
        except Exception as exc:  # noqa: BLE001
            report.add(
                ImportItemResult(
                    index=record.index,
                    item_id=record.item_id,
                    source=record.source.value,
                    source_ref=record.source_ref,
                    status="failed",
                    message=str(exc),
                    title=record.title,
                )
            )
            if args.stop_on_error:
                break

    report.finished_at = now_iso()
    _write_report(report, args.report, as_json=False)
    _write_report(report, args.json_report, as_json=True)
    _print_summary(report)

    if report.has_failures:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
