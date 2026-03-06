#!/usr/bin/env python3
"""이관/운영 데이터 정합성 검사 스크립트."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import (
    BrandingSetting,
    Category,
    Document,
    DocumentComment,
    DocumentFile,
    DocumentTag,
    DocumentVersion,
    File,
    IngestEvent,
    IngestJob,
    SourceType,
    Tag,
)
from app.db.session import SessionLocal


SEV_ERROR = "ERROR"
SEV_WARN = "WARN"
SEV_INFO = "INFO"
NO_SUCH_OBJECT_CODES = {"NoSuchKey", "NoSuchObject", "NoSuchBucket"}


@dataclass
class Finding:
    code: str
    severity: str
    message: str
    count: int = 0
    samples: list[str] = field(default_factory=list)


@dataclass
class IntegrityReport:
    started_at: str
    finished_at: str
    settings_summary: dict[str, Any]
    row_counts: dict[str, int] = field(default_factory=dict)
    findings: list[Finding] = field(default_factory=list)

    def add(self, code: str, severity: str, message: str, count: int = 0, samples: list[str] | None = None) -> None:
        self.findings.append(
            Finding(
                code=code,
                severity=severity,
                message=message,
                count=count,
                samples=samples or [],
            )
        )

    @property
    def error_count(self) -> int:
        return sum(1 for item in self.findings if item.severity == SEV_ERROR)

    @property
    def warn_count(self) -> int:
        return sum(1 for item in self.findings if item.severity == SEV_WARN)

    def to_dict(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "settings_summary": self.settings_summary,
            "row_counts": self.row_counts,
            "summary": {
                "total_findings": len(self.findings),
                "error_count": self.error_count,
                "warn_count": self.warn_count,
            },
            "findings": [asdict(item) for item in self.findings],
        }

    def to_text(self) -> str:
        lines: list[str] = []
        lines.append("# Integrity Report")
        lines.append(f"- started_at: {self.started_at}")
        lines.append(f"- finished_at: {self.finished_at}")
        lines.append(f"- database_url: {self.settings_summary['database_url']}")
        lines.append(f"- storage_backend: {self.settings_summary['storage_backend']}")
        lines.append(f"- storage_check_mode: {self.settings_summary['storage_check_mode']}")
        lines.append(f"- storage_probe_limit: {self.settings_summary['storage_probe_limit']}")
        lines.append("")
        lines.append("## Row Counts")
        for table_name in sorted(self.row_counts.keys()):
            lines.append(f"- {table_name}: {self.row_counts[table_name]}")
        lines.append("")
        lines.append("## Findings")
        lines.append(f"- total: {len(self.findings)}")
        lines.append(f"- errors: {self.error_count}")
        lines.append(f"- warnings: {self.warn_count}")
        lines.append("")

        if not self.findings:
            lines.append("정합성 문제를 발견하지 못했습니다.")
            return "\n".join(lines) + "\n"

        severity_order = {SEV_ERROR: 0, SEV_WARN: 1, SEV_INFO: 2}
        sorted_findings = sorted(self.findings, key=lambda item: (severity_order.get(item.severity, 99), item.code))
        for finding in sorted_findings:
            lines.append(f"### [{finding.severity}] {finding.code}")
            lines.append(f"- message: {finding.message}")
            lines.append(f"- count: {finding.count}")
            if finding.samples:
                lines.append("- samples:")
                for sample in finding.samples:
                    lines.append(f"  - {sample}")
            lines.append("")

        return "\n".join(lines) + "\n"


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def mask_database_url(db_url: str) -> str:
    if "@" not in db_url:
        return db_url
    prefix, suffix = db_url.rsplit("@", 1)
    if "://" not in prefix:
        return f"***@{suffix}"
    scheme, _ = prefix.split("://", 1)
    return f"{scheme}://***@{suffix}"


def format_uuid_like(value: Any) -> str:
    return str(value) if value is not None else "None"


def table_counts(db: Session) -> dict[str, int]:
    return {
        "categories": int(db.execute(select(func.count()).select_from(Category)).scalar_one() or 0),
        "tags": int(db.execute(select(func.count()).select_from(Tag)).scalar_one() or 0),
        "files": int(db.execute(select(func.count()).select_from(File)).scalar_one() or 0),
        "documents": int(db.execute(select(func.count()).select_from(Document)).scalar_one() or 0),
        "document_versions": int(db.execute(select(func.count()).select_from(DocumentVersion)).scalar_one() or 0),
        "document_files": int(db.execute(select(func.count()).select_from(DocumentFile)).scalar_one() or 0),
        "document_tags": int(db.execute(select(func.count()).select_from(DocumentTag)).scalar_one() or 0),
        "document_comments": int(db.execute(select(func.count()).select_from(DocumentComment)).scalar_one() or 0),
        "ingest_jobs": int(db.execute(select(func.count()).select_from(IngestJob)).scalar_one() or 0),
        "ingest_events": int(db.execute(select(func.count()).select_from(IngestEvent)).scalar_one() or 0),
    }


def check_orphans(db: Session, report: IntegrityReport, max_samples: int) -> None:
    # documents.category_id -> categories.id
    doc_cat_count_stmt = (
        select(func.count())
        .select_from(Document)
        .outerjoin(Category, Category.id == Document.category_id)
        .where(Document.category_id.is_not(None), Category.id.is_(None))
    )
    doc_cat_sample_stmt = (
        select(Document.id, Document.category_id)
        .select_from(Document)
        .outerjoin(Category, Category.id == Document.category_id)
        .where(Document.category_id.is_not(None), Category.id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(doc_cat_count_stmt).scalar_one() or 0)
    if count > 0:
        rows = db.execute(doc_cat_sample_stmt).all()
        samples = [f"document_id={format_uuid_like(row.id)} category_id={format_uuid_like(row.category_id)}" for row in rows]
        report.add("ORPHAN_DOCUMENT_CATEGORY", SEV_ERROR, "category_id가 존재하지 않는 문서가 있습니다.", count, samples)

    # document_files.document_id -> documents.id
    df_doc_count_stmt = (
        select(func.count())
        .select_from(DocumentFile)
        .outerjoin(Document, Document.id == DocumentFile.document_id)
        .where(Document.id.is_(None))
    )
    df_doc_sample_stmt = (
        select(DocumentFile.id, DocumentFile.document_id, DocumentFile.file_id)
        .select_from(DocumentFile)
        .outerjoin(Document, Document.id == DocumentFile.document_id)
        .where(Document.id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(df_doc_count_stmt).scalar_one() or 0)
    if count > 0:
        rows = db.execute(df_doc_sample_stmt).all()
        samples = [
            f"document_file_id={format_uuid_like(row.id)} document_id={format_uuid_like(row.document_id)} file_id={format_uuid_like(row.file_id)}"
            for row in rows
        ]
        report.add("ORPHAN_DOCUMENT_FILE_DOCUMENT", SEV_ERROR, "document_files.document_id가 유효하지 않습니다.", count, samples)

    # document_files.file_id -> files.id
    df_file_count_stmt = (
        select(func.count())
        .select_from(DocumentFile)
        .outerjoin(File, File.id == DocumentFile.file_id)
        .where(File.id.is_(None))
    )
    df_file_sample_stmt = (
        select(DocumentFile.id, DocumentFile.document_id, DocumentFile.file_id)
        .select_from(DocumentFile)
        .outerjoin(File, File.id == DocumentFile.file_id)
        .where(File.id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(df_file_count_stmt).scalar_one() or 0)
    if count > 0:
        rows = db.execute(df_file_sample_stmt).all()
        samples = [
            f"document_file_id={format_uuid_like(row.id)} document_id={format_uuid_like(row.document_id)} file_id={format_uuid_like(row.file_id)}"
            for row in rows
        ]
        report.add("ORPHAN_DOCUMENT_FILE_FILE", SEV_ERROR, "document_files.file_id가 유효하지 않습니다.", count, samples)

    # document_tags.document_id -> documents.id
    dt_doc_count_stmt = (
        select(func.count())
        .select_from(DocumentTag)
        .outerjoin(Document, Document.id == DocumentTag.document_id)
        .where(Document.id.is_(None))
    )
    dt_doc_sample_stmt = (
        select(DocumentTag.document_id, DocumentTag.tag_id)
        .select_from(DocumentTag)
        .outerjoin(Document, Document.id == DocumentTag.document_id)
        .where(Document.id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(dt_doc_count_stmt).scalar_one() or 0)
    if count > 0:
        rows = db.execute(dt_doc_sample_stmt).all()
        samples = [f"document_id={format_uuid_like(row.document_id)} tag_id={format_uuid_like(row.tag_id)}" for row in rows]
        report.add("ORPHAN_DOCUMENT_TAG_DOCUMENT", SEV_ERROR, "document_tags.document_id가 유효하지 않습니다.", count, samples)

    # document_tags.tag_id -> tags.id
    dt_tag_count_stmt = (
        select(func.count())
        .select_from(DocumentTag)
        .outerjoin(Tag, Tag.id == DocumentTag.tag_id)
        .where(Tag.id.is_(None))
    )
    dt_tag_sample_stmt = (
        select(DocumentTag.document_id, DocumentTag.tag_id)
        .select_from(DocumentTag)
        .outerjoin(Tag, Tag.id == DocumentTag.tag_id)
        .where(Tag.id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(dt_tag_count_stmt).scalar_one() or 0)
    if count > 0:
        rows = db.execute(dt_tag_sample_stmt).all()
        samples = [f"document_id={format_uuid_like(row.document_id)} tag_id={format_uuid_like(row.tag_id)}" for row in rows]
        report.add("ORPHAN_DOCUMENT_TAG_TAG", SEV_ERROR, "document_tags.tag_id가 유효하지 않습니다.", count, samples)

    # document_versions.document_id -> documents.id
    dv_doc_count_stmt = (
        select(func.count())
        .select_from(DocumentVersion)
        .outerjoin(Document, Document.id == DocumentVersion.document_id)
        .where(Document.id.is_(None))
    )
    dv_doc_sample_stmt = (
        select(DocumentVersion.id, DocumentVersion.document_id, DocumentVersion.version_no)
        .select_from(DocumentVersion)
        .outerjoin(Document, Document.id == DocumentVersion.document_id)
        .where(Document.id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(dv_doc_count_stmt).scalar_one() or 0)
    if count > 0:
        rows = db.execute(dv_doc_sample_stmt).all()
        samples = [
            f"document_version_id={format_uuid_like(row.id)} document_id={format_uuid_like(row.document_id)} version_no={row.version_no}"
            for row in rows
        ]
        report.add("ORPHAN_DOCUMENT_VERSION_DOCUMENT", SEV_ERROR, "document_versions.document_id가 유효하지 않습니다.", count, samples)

    # document_comments.document_id -> documents.id
    dc_doc_count_stmt = (
        select(func.count())
        .select_from(DocumentComment)
        .outerjoin(Document, Document.id == DocumentComment.document_id)
        .where(Document.id.is_(None))
    )
    dc_doc_sample_stmt = (
        select(DocumentComment.id, DocumentComment.document_id)
        .select_from(DocumentComment)
        .outerjoin(Document, Document.id == DocumentComment.document_id)
        .where(Document.id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(dc_doc_count_stmt).scalar_one() or 0)
    if count > 0:
        rows = db.execute(dc_doc_sample_stmt).all()
        samples = [
            f"document_comment_id={format_uuid_like(row.id)} document_id={format_uuid_like(row.document_id)}" for row in rows
        ]
        report.add("ORPHAN_DOCUMENT_COMMENT_DOCUMENT", SEV_ERROR, "document_comments.document_id가 유효하지 않습니다.", count, samples)

    # ingest_jobs.document_id -> documents.id
    job_doc_count_stmt = (
        select(func.count())
        .select_from(IngestJob)
        .outerjoin(Document, Document.id == IngestJob.document_id)
        .where(IngestJob.document_id.is_not(None), Document.id.is_(None))
    )
    job_doc_sample_stmt = (
        select(IngestJob.id, IngestJob.document_id, IngestJob.source, IngestJob.source_ref)
        .select_from(IngestJob)
        .outerjoin(Document, Document.id == IngestJob.document_id)
        .where(IngestJob.document_id.is_not(None), Document.id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(job_doc_count_stmt).scalar_one() or 0)
    if count > 0:
        rows = db.execute(job_doc_sample_stmt).all()
        samples = [
            f"ingest_job_id={format_uuid_like(row.id)} document_id={format_uuid_like(row.document_id)} source={row.source} source_ref={row.source_ref}"
            for row in rows
        ]
        report.add("ORPHAN_INGEST_JOB_DOCUMENT", SEV_WARN, "ingest_jobs.document_id가 유효하지 않습니다.", count, samples)

    # ingest_events.ingest_job_id -> ingest_jobs.id
    event_job_count_stmt = (
        select(func.count())
        .select_from(IngestEvent)
        .outerjoin(IngestJob, IngestJob.id == IngestEvent.ingest_job_id)
        .where(IngestJob.id.is_(None))
    )
    event_job_sample_stmt = (
        select(IngestEvent.id, IngestEvent.ingest_job_id, IngestEvent.event_type, IngestEvent.to_state)
        .select_from(IngestEvent)
        .outerjoin(IngestJob, IngestJob.id == IngestEvent.ingest_job_id)
        .where(IngestJob.id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(event_job_count_stmt).scalar_one() or 0)
    if count > 0:
        rows = db.execute(event_job_sample_stmt).all()
        samples = [
            f"ingest_event_id={row.id} ingest_job_id={format_uuid_like(row.ingest_job_id)} event_type={row.event_type} to_state={row.to_state}"
            for row in rows
        ]
        report.add("ORPHAN_INGEST_EVENT_JOB", SEV_ERROR, "ingest_events.ingest_job_id가 유효하지 않습니다.", count, samples)


def check_unlinked_files(db: Session, report: IntegrityReport, max_samples: int) -> None:
    unlinked_count_stmt = (
        select(func.count())
        .select_from(File)
        .outerjoin(DocumentFile, DocumentFile.file_id == File.id)
        .outerjoin(BrandingSetting, BrandingSetting.logo_file_id == File.id)
        .where(DocumentFile.file_id.is_(None), BrandingSetting.logo_file_id.is_(None))
    )
    unlinked_sample_stmt = (
        select(File.id, File.original_filename, File.storage_backend, File.storage_key)
        .select_from(File)
        .outerjoin(DocumentFile, DocumentFile.file_id == File.id)
        .outerjoin(BrandingSetting, BrandingSetting.logo_file_id == File.id)
        .where(DocumentFile.file_id.is_(None), BrandingSetting.logo_file_id.is_(None))
        .limit(max_samples)
    )
    count = int(db.execute(unlinked_count_stmt).scalar_one() or 0)
    if count <= 0:
        return
    rows = db.execute(unlinked_sample_stmt).all()
    samples = [
        (
            f"file_id={format_uuid_like(row.id)} "
            f"name={row.original_filename} backend={row.storage_backend} key={row.storage_key}"
        )
        for row in rows
    ]
    report.add(
        "UNLINKED_FILE_RECORD",
        SEV_WARN,
        "문서에 연결되지 않은 files 레코드가 있습니다. 필요 시 정리(cleanup)하세요.",
        count,
        samples,
    )


def check_document_versions(db: Session, report: IntegrityReport, max_samples: int) -> None:
    max_version_subq = (
        select(
            DocumentVersion.document_id.label("document_id"),
            func.max(DocumentVersion.version_no).label("max_version_no"),
        )
        .group_by(DocumentVersion.document_id)
        .subquery()
    )

    mismatch_count_stmt = (
        select(func.count())
        .select_from(Document)
        .outerjoin(max_version_subq, max_version_subq.c.document_id == Document.id)
        .where(func.coalesce(max_version_subq.c.max_version_no, 1) != Document.current_version_no)
    )
    mismatch_sample_stmt = (
        select(
            Document.id,
            Document.current_version_no,
            max_version_subq.c.max_version_no,
        )
        .select_from(Document)
        .outerjoin(max_version_subq, max_version_subq.c.document_id == Document.id)
        .where(func.coalesce(max_version_subq.c.max_version_no, 1) != Document.current_version_no)
        .limit(max_samples)
    )
    mismatch_count = int(db.execute(mismatch_count_stmt).scalar_one() or 0)
    if mismatch_count > 0:
        rows = db.execute(mismatch_sample_stmt).all()
        samples = [
            f"document_id={format_uuid_like(row.id)} current_version_no={row.current_version_no} max_version_no={row.max_version_no}"
            for row in rows
        ]
        report.add(
            "DOCUMENT_VERSION_MISMATCH",
            SEV_ERROR,
            "documents.current_version_no와 document_versions 최대 버전이 불일치합니다.",
            mismatch_count,
            samples,
        )

    no_version_count_stmt = (
        select(func.count())
        .select_from(Document)
        .outerjoin(DocumentVersion, DocumentVersion.document_id == Document.id)
        .where(DocumentVersion.id.is_(None))
    )
    no_version_sample_stmt = (
        select(Document.id, Document.title, Document.current_version_no)
        .select_from(Document)
        .outerjoin(DocumentVersion, DocumentVersion.document_id == Document.id)
        .where(DocumentVersion.id.is_(None))
        .limit(max_samples)
    )
    no_version_count = int(db.execute(no_version_count_stmt).scalar_one() or 0)
    if no_version_count > 0:
        rows = db.execute(no_version_sample_stmt).all()
        samples = [
            f"document_id={format_uuid_like(row.id)} title={row.title} current_version_no={row.current_version_no}" for row in rows
        ]
        report.add(
            "DOCUMENT_WITHOUT_VERSION_ROW",
            SEV_WARN,
            "document_versions row가 없는 documents가 있습니다.",
            no_version_count,
            samples,
        )


def check_checksum_and_source_ref(db: Session, report: IntegrityReport, max_samples: int) -> None:
    invalid_checksum_count_stmt = (
        select(func.count())
        .select_from(File)
        .where(
            File.checksum_sha256.is_(None)
            | (~File.checksum_sha256.op("~")(r"^[0-9A-Fa-f]{64}$"))
        )
    )
    invalid_checksum_sample_stmt = (
        select(File.id, File.checksum_sha256, File.original_filename)
        .where(
            File.checksum_sha256.is_(None)
            | (~File.checksum_sha256.op("~")(r"^[0-9A-Fa-f]{64}$"))
        )
        .limit(max_samples)
    )
    invalid_count = int(db.execute(invalid_checksum_count_stmt).scalar_one() or 0)
    if invalid_count > 0:
        rows = db.execute(invalid_checksum_sample_stmt).all()
        samples = [
            f"file_id={format_uuid_like(row.id)} checksum={row.checksum_sha256} filename={row.original_filename}" for row in rows
        ]
        report.add("INVALID_FILE_CHECKSUM", SEV_ERROR, "files.checksum_sha256 형식이 잘못되었습니다.", invalid_count, samples)

    dup_doc_ref_stmt = (
        select(Document.source_ref, func.count().label("ref_count"))
        .where(Document.source == SourceType.telegram, Document.source_ref.is_not(None))
        .group_by(Document.source_ref)
        .having(func.count() > 1)
        .order_by(func.count().desc(), Document.source_ref.asc())
        .limit(max_samples)
    )
    dup_doc_rows = db.execute(dup_doc_ref_stmt).all()
    if dup_doc_rows:
        report.add(
            "DUPLICATE_TELEGRAM_DOCUMENT_SOURCE_REF",
            SEV_ERROR,
            "telegram documents에 중복 source_ref가 존재합니다.",
            len(dup_doc_rows),
            [f"source_ref={row.source_ref} duplicated={row.ref_count}" for row in dup_doc_rows],
        )

    dup_job_ref_stmt = (
        select(IngestJob.source_ref, func.count().label("ref_count"))
        .where(IngestJob.source == SourceType.telegram, IngestJob.source_ref.is_not(None))
        .group_by(IngestJob.source_ref)
        .having(func.count() > 1)
        .order_by(func.count().desc(), IngestJob.source_ref.asc())
        .limit(max_samples)
    )
    dup_job_rows = db.execute(dup_job_ref_stmt).all()
    if dup_job_rows:
        report.add(
            "DUPLICATE_TELEGRAM_INGEST_SOURCE_REF",
            SEV_ERROR,
            "telegram ingest_jobs에 중복 source_ref가 존재합니다.",
            len(dup_job_rows),
            [f"source_ref={row.source_ref} duplicated={row.ref_count}" for row in dup_job_rows],
        )


def check_storage_objects(
    db: Session,
    report: IntegrityReport,
    storage_mode: str,
    storage_probe_limit: int,
    max_samples: int,
) -> None:
    settings = get_settings()
    mode = storage_mode
    if mode == "auto":
        mode = settings.storage_backend if settings.storage_backend in {"disk", "minio"} else "none"

    if mode == "none":
        report.add("STORAGE_CHECK_SKIPPED", SEV_INFO, "storage object 존재 검사를 생략했습니다.")
        return

    query = (
        select(File.id, File.storage_backend, File.storage_key, File.bucket, File.original_filename)
        .where(File.storage_backend == mode)
        .order_by(File.created_at.asc())
        .limit(storage_probe_limit)
    )
    rows = db.execute(query).all()
    if not rows:
        report.add("STORAGE_CHECK_NO_TARGET", SEV_INFO, f"storage_backend={mode} 대상 파일이 없습니다.")
        return

    missing: list[str] = []
    checked_count = 0

    if mode == "disk":
        root = Path(settings.storage_disk_root)
        for row in rows:
            checked_count += 1
            full_path = root / row.storage_key
            if not full_path.exists():
                missing.append(
                    f"file_id={format_uuid_like(row.id)} key={row.storage_key} expected_path={full_path}"
                )
    elif mode == "minio":
        try:
            from minio.error import S3Error
            from app.services.storage_minio import get_minio_client
        except ModuleNotFoundError:
            report.add(
                "MINIO_LIBRARY_MISSING",
                SEV_WARN,
                "minio 라이브러리가 없어 minio storage 검사를 수행하지 못했습니다.",
            )
            return

        client = get_minio_client(
            endpoint=settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )
        for row in rows:
            checked_count += 1
            try:
                client.stat_object(bucket_name=row.bucket, object_name=row.storage_key)
            except S3Error as exc:
                if exc.code in NO_SUCH_OBJECT_CODES:
                    missing.append(
                        f"file_id={format_uuid_like(row.id)} bucket={row.bucket} key={row.storage_key} code={exc.code}"
                    )
                else:
                    missing.append(
                        f"file_id={format_uuid_like(row.id)} bucket={row.bucket} key={row.storage_key} code={exc.code}"
                    )
            except Exception as exc:  # pragma: no cover
                missing.append(
                    f"file_id={format_uuid_like(row.id)} bucket={row.bucket} key={row.storage_key} error={exc.__class__.__name__}"
                )
    else:
        report.add("STORAGE_CHECK_UNSUPPORTED_MODE", SEV_WARN, f"지원하지 않는 storage check mode: {mode}")
        return

    if missing:
        report.add(
            "MISSING_STORAGE_OBJECT",
            SEV_ERROR,
            f"storage_backend={mode}에서 실물 파일 누락이 발견되었습니다.",
            len(missing),
            missing[:max_samples],
        )
    else:
        report.add("STORAGE_OBJECT_OK", SEV_INFO, f"storage_backend={mode} 실물 파일 검사 정상 ({checked_count}건).")

    total_backend_files = int(
        db.execute(
            select(func.count()).select_from(File).where(File.storage_backend == mode)
        ).scalar_one()
        or 0
    )
    if total_backend_files > storage_probe_limit:
        report.add(
            "STORAGE_CHECK_PARTIAL",
            SEV_WARN,
            "storage object 검사가 전체가 아닌 샘플(상한) 기반으로 수행되었습니다.",
            total_backend_files - storage_probe_limit,
            [f"checked={storage_probe_limit} total={total_backend_files}"],
        )


def run_checks(db: Session, report: IntegrityReport, max_samples: int, storage_mode: str, storage_probe_limit: int) -> None:
    report.row_counts = table_counts(db)

    check_orphans(db, report, max_samples)
    check_unlinked_files(db, report, max_samples)
    check_document_versions(db, report, max_samples)
    check_checksum_and_source_ref(db, report, max_samples)
    check_storage_objects(db, report, storage_mode, storage_probe_limit, max_samples)

    if report.error_count == 0 and report.warn_count == 0:
        report.add("INTEGRITY_OK", SEV_INFO, "치명적인 정합성 이슈가 발견되지 않았습니다.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="이관/운영 데이터 정합성 검사")
    parser.add_argument("--report", default="integrity_report.txt", help="텍스트 리포트 경로")
    parser.add_argument("--json-report", default=None, help="JSON 리포트 경로(optional)")
    parser.add_argument("--max-samples", type=int, default=20, help="항목별 샘플 최대 출력 수")
    parser.add_argument(
        "--check-storage",
        choices=["auto", "none", "disk", "minio"],
        default="auto",
        help="실물 파일 존재 검증 모드",
    )
    parser.add_argument("--storage-probe-limit", type=int, default=2000, help="실물 파일 검사 최대 건수")
    parser.add_argument("--fail-on-error", action="store_true", help="ERROR 발견 시 종료코드 2로 종료")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    settings = get_settings()
    started_at = now_iso()

    report = IntegrityReport(
        started_at=started_at,
        finished_at=started_at,
        settings_summary={
            "database_url": mask_database_url(settings.database_url),
            "storage_backend": settings.storage_backend,
            "storage_check_mode": args.check_storage,
            "storage_probe_limit": int(args.storage_probe_limit),
        },
    )

    with SessionLocal() as db:
        run_checks(
            db=db,
            report=report,
            max_samples=max(1, int(args.max_samples)),
            storage_mode=args.check_storage,
            storage_probe_limit=max(1, int(args.storage_probe_limit)),
        )

    report.finished_at = now_iso()

    text_path = Path(args.report)
    text_path.write_text(report.to_text(), encoding="utf-8")
    print(f"text report generated: {text_path}")

    if args.json_report:
        json_path = Path(args.json_report)
        json_path.write_text(
            json.dumps(report.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"json report generated: {json_path}")

    print(
        f"summary: findings={len(report.findings)} errors={report.error_count} warnings={report.warn_count}"
    )
    if args.fail_on_error and report.error_count > 0:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
