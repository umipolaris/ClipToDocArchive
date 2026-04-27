"""Robust event-date parser.

Goal: cover the date formats that real users put in captions, filenames
and document bodies — not just `YYYY-MM-DD`.

Strategy: scan the input with a prioritized ordered list of patterns and
return the first valid date that fits the temporal window (within ±2
years of the ingest timestamp by default; this filters out unrelated
4-digit numbers like part numbers or doc IDs).

Patterns supported (high precision first):
  - ISO with separators: 2026-04-27, 2026/04/27, 2026.04.27
  - Compact 8-digit:    20260427  (only when surrounded by non-digits)
  - Korean full:        2026년 4월 27일, 26년 4월 27일
  - Korean year-month:  2026년 4월     (day defaults to 1)
  - Korean month-day:   4월 27일       (year inferred from ingested_at)
  - English month name: April 27, 2026 / 27 Apr 2026 / Apr 2026
  - Compact 6-digit:    260427         (YYMMDD, century-inferred)
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

_PATTERNS_FULL = [
    re.compile(r"(?<!\d)(?P<y>\d{4})[-./](?P<m>\d{1,2})[-./](?P<d>\d{1,2})(?!\d)"),
    re.compile(r"(?<!\d)(?P<y>\d{4})(?P<m>\d{2})(?P<d>\d{2})(?!\d)"),
]
_PATTERN_KO_FULL = re.compile(
    r"(?P<y>\d{2,4})\s*년\s*(?P<m>\d{1,2})\s*월\s*(?P<d>\d{1,2})\s*일"
)
_PATTERN_KO_YEAR_MONTH = re.compile(r"(?P<y>\d{2,4})\s*년\s*(?P<m>\d{1,2})\s*월(?!\s*\d{1,2}\s*일)")
_PATTERN_KO_MONTH_DAY = re.compile(r"(?<!\d)(?P<m>\d{1,2})\s*월\s*(?P<d>\d{1,2})\s*일")

_MONTHS = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}
_MONTH_RX = "|".join(sorted(_MONTHS.keys(), key=len, reverse=True))
_PATTERN_EN_MDY = re.compile(
    rf"(?P<mon>{_MONTH_RX})\s*\.?\s*(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s*(?P<y>\d{{4}})",
    re.IGNORECASE,
)
_PATTERN_EN_DMY = re.compile(
    rf"(?<!\d)(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\s+(?P<mon>{_MONTH_RX})\s*\.?\s*,?\s*(?P<y>\d{{4}})",
    re.IGNORECASE,
)
_PATTERN_EN_MY = re.compile(
    rf"(?P<mon>{_MONTH_RX})\s*\.?\s*,?\s*(?P<y>\d{{4}})(?!\s*\d)",
    re.IGNORECASE,
)
_PATTERN_YYMMDD = re.compile(r"(?<!\d)(?P<y>\d{2})(?P<m>\d{2})(?P<d>\d{2})(?!\d)")
_PATTERN_KO_YEAR_ONLY = re.compile(r"(?P<y>\d{4})\s*년(?!\s*\d)")
_PATTERN_KO_MONTH_ONLY = re.compile(r"(?<!\d)(?P<m>\d{1,2})\s*월(?!\s*\d)")
_PATTERN_QUARTER = re.compile(r"(?P<y>\d{4})\s*[-./_ ]?\s*[Qq](?P<q>[1-4])|(?<![A-Za-z])[Qq](?P<q2>[1-4])\s*[-./_ ]?\s*(?P<y2>\d{4})")
_PATTERN_SLASH_MD = re.compile(r"(?<!\d)(?P<m>\d{1,2})/(?P<d>\d{1,2})(?!\d)")
_PATTERN_DOT_MD = re.compile(r"(?<!\d)(?P<m>\d{1,2})\.(?P<d>\d{1,2})(?!\d|\.\d)")


def _safe_date(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _resolve_year(raw_year: int, ingested_at: datetime) -> int:
    if raw_year >= 100:
        return raw_year
    base = ingested_at.year % 100
    year = 2000 + raw_year if raw_year <= base + 1 else 1900 + raw_year
    candidate = date(year, 1, 1)
    if candidate > (ingested_at + timedelta(days=365)).date():
        year -= 100
    return year


def _within_window(parsed: date, ingested_at: datetime, *, years: int = 5) -> bool:
    """Reject obvious garbage like 1804 or 9999 sneaking in via 4-digit substrings.

    Documents are expected within ±`years` of the ingest date for full numeric
    matches. Korean/English textual patterns get a wider window (handled by
    skipping this check at the call site).
    """
    base_year = ingested_at.year
    return (base_year - years) <= parsed.year <= (base_year + years)


def parse_event_date_from_text(text: str | None, ingested_at: datetime) -> date | None:
    if not text:
        return None

    # 1) Full ISO-ish numeric — strict window (avoid random 4-digit hits).
    for pattern in _PATTERNS_FULL:
        for match in pattern.finditer(text):
            y = int(match.group("y"))
            m = int(match.group("m"))
            d = int(match.group("d"))
            parsed = _safe_date(y, m, d)
            if parsed and _within_window(parsed, ingested_at, years=20):
                return parsed

    # 2) Korean YYYY/YY 년 M 월 D 일 — wide window OK (text is unambiguous).
    m_ko = _PATTERN_KO_FULL.search(text)
    if m_ko:
        year = _resolve_year(int(m_ko.group("y")), ingested_at)
        month = int(m_ko.group("m"))
        day = int(m_ko.group("d"))
        parsed = _safe_date(year, month, day)
        if parsed:
            return parsed

    # 3) Korean YYYY 년 M 월 (day defaults to 1).
    m_ko_ym = _PATTERN_KO_YEAR_MONTH.search(text)
    if m_ko_ym:
        year = _resolve_year(int(m_ko_ym.group("y")), ingested_at)
        month = int(m_ko_ym.group("m"))
        parsed = _safe_date(year, month, 1)
        if parsed:
            return parsed

    # 4) English Month-Day-Year and Day-Month-Year.
    for rx in (_PATTERN_EN_MDY, _PATTERN_EN_DMY):
        m_en = rx.search(text)
        if m_en:
            month = _MONTHS[m_en.group("mon").lower().rstrip(".")]
            day = int(m_en.group("d"))
            year = int(m_en.group("y"))
            parsed = _safe_date(year, month, day)
            if parsed:
                return parsed

    # 5) English Month-Year (day defaults to 1).
    m_en_my = _PATTERN_EN_MY.search(text)
    if m_en_my:
        month = _MONTHS[m_en_my.group("mon").lower().rstrip(".")]
        year = int(m_en_my.group("y"))
        parsed = _safe_date(year, month, 1)
        if parsed:
            return parsed

    # 6) Korean month-day only — infer year from ingest date.
    m_ko_md = _PATTERN_KO_MONTH_DAY.search(text)
    if m_ko_md:
        month = int(m_ko_md.group("m"))
        day = int(m_ko_md.group("d"))
        parsed = _safe_date(ingested_at.year, month, day)
        if parsed:
            return parsed

    # 7) Compact YYMMDD (last resort numeric — can false-positive).
    match_yy = _PATTERN_YYMMDD.search(text)
    if match_yy:
        year = _resolve_year(int(match_yy.group("y")), ingested_at)
        month = int(match_yy.group("m"))
        day = int(match_yy.group("d"))
        parsed = _safe_date(year, month, day)
        if parsed:
            return parsed

    # 8) Quarter notation: "2026 Q3", "Q3 2026", "2026Q3" -> first day of quarter.
    m_q = _PATTERN_QUARTER.search(text)
    if m_q:
        y_raw = m_q.group("y") or m_q.group("y2")
        q_raw = m_q.group("q") or m_q.group("q2")
        if y_raw and q_raw:
            quarter_month = (int(q_raw) - 1) * 3 + 1
            parsed = _safe_date(int(y_raw), quarter_month, 1)
            if parsed:
                return parsed

    # 9) Slash / dot M/D (e.g. "3/27", "3.27") — current year inferred.
    for rx in (_PATTERN_SLASH_MD, _PATTERN_DOT_MD):
        m_md = rx.search(text)
        if m_md:
            month = int(m_md.group("m"))
            day = int(m_md.group("d"))
            if 1 <= month <= 12 and 1 <= day <= 31:
                parsed = _safe_date(ingested_at.year, month, day)
                if parsed:
                    return parsed

    # 10) Korean year-only ("2026년") -> Jan 1 of that year.
    m_y = _PATTERN_KO_YEAR_ONLY.search(text)
    if m_y:
        parsed = _safe_date(int(m_y.group("y")), 1, 1)
        if parsed:
            return parsed

    # 11) Korean month-only ("3월") -> first day of that month, current year.
    m_m = _PATTERN_KO_MONTH_ONLY.search(text)
    if m_m:
        month = int(m_m.group("m"))
        if 1 <= month <= 12:
            parsed = _safe_date(ingested_at.year, month, 1)
            if parsed:
                return parsed

    return None
