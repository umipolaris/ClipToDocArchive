from __future__ import annotations

from sqlalchemy.exc import IntegrityError


class IngestErrorCode:
    STORAGE_TEMP_FILE_MISSING = "STORAGE_TEMP_FILE_MISSING"
    STORAGE_READ_FAIL = "STORAGE_READ_FAIL"
    STORAGE_WRITE_FAIL = "STORAGE_WRITE_FAIL"
    CAPTION_PARSE_FAIL = "CAPTION_PARSE_FAIL"
    SUMMARY_EXTRACT_FAIL = "SUMMARY_EXTRACT_FAIL"
    RULE_CLASSIFY_FAIL = "RULE_CLASSIFY_FAIL"
    DB_WRITE_FAIL = "DB_WRITE_FAIL"
    NOTIFY_CALLBACK_FAIL = "NOTIFY_CALLBACK_FAIL"
    PIPELINE_UNEXPECTED = "PIPELINE_UNEXPECTED"


class IngestPipelineError(RuntimeError):
    def __init__(self, code: str, stage: str, message: str):
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.message = message


def classify_exception_for_stage(exc: Exception, stage: str) -> str:
    if stage == "STORED":
        if isinstance(exc, FileNotFoundError):
            return IngestErrorCode.STORAGE_TEMP_FILE_MISSING
        if isinstance(exc, PermissionError):
            return IngestErrorCode.STORAGE_READ_FAIL
        return IngestErrorCode.STORAGE_WRITE_FAIL

    if stage == "EXTRACTED":
        return IngestErrorCode.CAPTION_PARSE_FAIL

    if stage == "CLASSIFIED":
        return IngestErrorCode.RULE_CLASSIFY_FAIL

    if stage == "INDEXED":
        if isinstance(exc, IntegrityError):
            return IngestErrorCode.DB_WRITE_FAIL
        return IngestErrorCode.DB_WRITE_FAIL

    return IngestErrorCode.PIPELINE_UNEXPECTED
