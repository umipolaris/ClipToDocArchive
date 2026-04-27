"""Document classification rule engine.

Scoring model (replaces the old "first-keyword-match wins" logic):

  - Each (rule, source) pair contributes a score = weight(source) × match_strength.
  - Sources are weighted: title > caption > description > filename > body > extension/mime.
  - Match strength: full-token = 1.0, substring = 0.6, normalised-substring = 0.5.
  - The category with the highest cumulative score wins, ties broken by
    the rule's declared `priority` (default 0) and then by ruleset order.
  - Threshold: a category needs ≥ MIN_SCORE to be confident; otherwise we
    fall back to tag-based / extension-based / default (= "기타") and only
    raise CLASSIFY_FAIL when nothing at all matched.

Default extension/MIME mapping is a minimal built-in list that fires only
when no rule matched — to give image / video / drawing files a sensible
home instead of "기타".
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime

from app.services.archive_set_parser import infer_structured_tags
from app.services.caption_parser import CaptionParseResult
from app.services.date_parser import parse_event_date_from_text
from app.services.rule_categories import extract_categories_from_rules_json


@dataclass
class RuleInput:
    caption: CaptionParseResult
    title: str
    description: str
    filename: str
    body_text: str
    metadata_date_text: str | None
    ingested_at: datetime
    mime_type: str | None = None


@dataclass
class RuleOutput:
    category: str
    tags: list[str]
    event_date: date
    review_reasons: list[str]


_AUTO_TAG_LIMIT = 3
_MIN_SCORE = 1.0  # any keyword anywhere ≥ substring is enough to commit
_SOURCE_WEIGHTS = {
    "title": 3.0,
    "caption": 2.5,
    "description": 1.5,
    "filename": 2.0,
    "body": 1.0,
}
_STRENGTH_TOKEN = 1.0
_STRENGTH_SUBSTRING = 0.6

_KIND_CATEGORY_MAP = {
    "manual": "매뉴얼",
    "guide": "가이드",
    "account-list": "계정 리스트",
    "drawing": "도면",
    "main": "절차",
}
_SET_CATEGORY_MAP = {
    "dcp": "DCP",
    "general-arrangement-drawing": "General Arrangement Drawing",
}
_GENERIC_CATEGORY_KEYS = {"기타", "default", "misc", "unknown", "uncategorized", "미분류"}

_EXTENSION_FALLBACK_CATEGORY = {
    "pdf": "문서",
    "doc": "문서",
    "docx": "문서",
    "hwp": "문서",
    "hwpx": "문서",
    "rtf": "문서",
    "txt": "문서",
    "md": "문서",
    "xls": "스프레드시트",
    "xlsx": "스프레드시트",
    "csv": "스프레드시트",
    "ppt": "프레젠테이션",
    "pptx": "프레젠테이션",
    "key": "프레젠테이션",
    "jpg": "사진",
    "jpeg": "사진",
    "png": "사진",
    "gif": "사진",
    "webp": "사진",
    "bmp": "사진",
    "tif": "사진",
    "tiff": "사진",
    "heic": "사진",
    "raw": "사진",
    "mp4": "영상",
    "mov": "영상",
    "avi": "영상",
    "mkv": "영상",
    "webm": "영상",
    "wav": "음성",
    "mp3": "음성",
    "flac": "음성",
    "m4a": "음성",
    "dwg": "도면",
    "dxf": "도면",
    "dwf": "도면",
    "stp": "도면",
    "step": "도면",
    "iges": "도면",
    "igs": "도면",
    "zip": "압축",
    "tar": "압축",
    "gz": "압축",
    "7z": "압축",
    "rar": "압축",
    "json": "데이터",
    "xml": "데이터",
    "yaml": "데이터",
    "yml": "데이터",
}

_MIME_FALLBACK_CATEGORY = {
    "image/": "사진",
    "video/": "영상",
    "audio/": "음성",
    "application/pdf": "문서",
    "application/zip": "압축",
    "application/x-7z-compressed": "압축",
    "application/x-tar": "압축",
}

_TOKEN_PATTERN = re.compile(r"[0-9A-Za-z가-힣]{2,}")
_STOPWORDS = {
    "the", "and", "for", "with", "from", "this", "that", "into", "your",
    "document", "file", "title", "description", "manual", "note",
    "분류", "날짜", "태그", "문서", "파일", "제목", "설명", "작성", "수정",
    "및", "또는", "그리고", "관련", "내용",
}


def _normalize_tag_key(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def _normalize_for_match(value: str) -> str:
    if not value:
        return ""
    return re.sub(r"[\s_\-./\\]+", " ", value).lower().strip()


def _tokenize(value: str) -> set[str]:
    if not value:
        return set()
    return {t.lower() for t in _TOKEN_PATTERN.findall(value)}


def _build_allowed_category_map(rules: dict | None) -> dict[str, str]:
    names = extract_categories_from_rules_json(rules if isinstance(rules, dict) else None)
    allowed: dict[str, str] = {}
    for raw in names:
        name = raw.strip()
        if not name:
            continue
        key = _normalize_tag_key(name)
        if key not in allowed:
            allowed[key] = name
    return allowed


@dataclass
class _CategoryCandidate:
    rule_index: int
    category: str
    tags: list[str] = field(default_factory=list)
    score: float = 0.0
    priority: int = 0
    matched_keywords: list[str] = field(default_factory=list)


def _score_keyword(text_norm: str, text_tokens: set[str], keyword: str) -> float:
    if not keyword:
        return 0.0
    kw_norm = _normalize_for_match(keyword)
    if not kw_norm:
        return 0.0
    if kw_norm in text_tokens:
        return _STRENGTH_TOKEN
    if " " in kw_norm or "-" in keyword or "_" in keyword:
        if kw_norm in text_norm:
            return _STRENGTH_SUBSTRING
        return 0.0
    if kw_norm in text_norm:
        return _STRENGTH_SUBSTRING
    return 0.0


def _score_rule_against_sources(
    rule: dict,
    sources: dict[str, str],
    *,
    rule_index: int,
) -> _CategoryCandidate | None:
    rule_keywords = rule.get("keywords", {})
    if not isinstance(rule_keywords, dict):
        return None
    category = str(rule.get("category") or "").strip()
    if not category:
        return None

    cumulative = 0.0
    matched: list[str] = []
    cached_norm: dict[str, str] = {}
    cached_tokens: dict[str, set[str]] = {}

    for source_name, weight in _SOURCE_WEIGHTS.items():
        text = sources.get(source_name) or ""
        if not text:
            continue
        keywords = rule_keywords.get(source_name) or rule_keywords.get("any") or []
        if not isinstance(keywords, list) or not keywords:
            continue
        if source_name not in cached_norm:
            cached_norm[source_name] = _normalize_for_match(text)
            cached_tokens[source_name] = _tokenize(text)
        text_norm = cached_norm[source_name]
        text_tokens = cached_tokens[source_name]
        for kw in keywords:
            if not isinstance(kw, str) or not kw.strip():
                continue
            strength = _score_keyword(text_norm, text_tokens, kw)
            if strength <= 0:
                continue
            cumulative += weight * strength
            matched.append(f"{source_name}:{kw}")

    if cumulative <= 0:
        return None

    rule_tags = rule.get("tags", [])
    tag_list = [str(t).strip() for t in rule_tags if isinstance(t, (str, int)) and str(t).strip()] if isinstance(rule_tags, list) else []
    priority = int(rule.get("priority", 0) or 0)

    return _CategoryCandidate(
        rule_index=rule_index,
        category=category,
        tags=tag_list,
        score=cumulative,
        priority=priority,
        matched_keywords=matched,
    )


def _category_from_extension_or_mime(filename: str | None, mime_type: str | None) -> str | None:
    if filename:
        suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if suffix and suffix in _EXTENSION_FALLBACK_CATEGORY:
            return _EXTENSION_FALLBACK_CATEGORY[suffix]
    if mime_type:
        mime = mime_type.lower()
        for prefix, cat in _MIME_FALLBACK_CATEGORY.items():
            if mime.startswith(prefix) if prefix.endswith("/") else mime == prefix:
                return cat
    return None


def _extract_keyword_tags(
    *,
    title: str,
    description: str,
    caption_raw: str,
    body_text: str,
    existing_tags: list[str],
    max_count: int = 12,
) -> list[str]:
    merged = " ".join((title or "", description or "", caption_raw or "", body_text[:2000] or "")).strip()
    if not merged:
        return []

    existing_keys = {_normalize_tag_key(tag) for tag in existing_tags if tag.strip()}
    inferred: list[str] = []

    for token in _TOKEN_PATTERN.findall(merged):
        lowered = token.lower()
        if lowered in _STOPWORDS:
            continue
        if token.isdigit():
            continue
        if re.fullmatch(r"\d{2,8}", token):
            continue

        normalized = token if not token.isascii() else lowered
        key = _normalize_tag_key(normalized)
        if key in existing_keys:
            continue

        inferred.append(normalized)
        existing_keys.add(key)
        if len(inferred) >= max_count:
            break

    return inferred


def _extract_structured_tag_map(tags: list[str]) -> dict[str, str]:
    tag_map: dict[str, str] = {}
    for raw in tags:
        tag = raw.strip()
        if ":" not in tag:
            continue
        key, value = tag.split(":", maxsplit=1)
        key = key.strip().lower()
        value = value.strip()
        if not key or not value or key in tag_map:
            continue
        tag_map[key] = value
    return tag_map


def _tag_matches_pattern(tag_values: set[str], pattern: str) -> bool:
    normalized_pattern = _normalize_tag_key(pattern)
    if not normalized_pattern:
        return False
    if normalized_pattern.endswith("*"):
        prefix = normalized_pattern[:-1]
        if not prefix:
            return False
        return any(value.startswith(prefix) for value in tag_values)
    return normalized_pattern in tag_values


def _infer_category_from_tag_rules(tags: list[str], rules: dict | None) -> str | None:
    if not isinstance(rules, dict):
        return None
    raw_tag_rules = rules.get("tag_category_rules", [])
    tag_rules = [rule for rule in raw_tag_rules if isinstance(rule, dict)] if isinstance(raw_tag_rules, list) else []
    if not tag_rules:
        return None

    normalized_tags = {_normalize_tag_key(tag) for tag in tags if tag.strip()}
    if not normalized_tags:
        return None

    for rule in tag_rules:
        category = str(rule.get("category") or "").strip()
        raw_patterns = rule.get("tags", [])
        patterns = [str(item).strip() for item in raw_patterns if str(item).strip()] if isinstance(raw_patterns, list) else []
        if not category or not patterns:
            continue
        match_mode = str(rule.get("match", "any")).strip().lower()
        if match_mode == "all":
            matched = all(_tag_matches_pattern(normalized_tags, pattern) for pattern in patterns)
        else:
            matched = any(_tag_matches_pattern(normalized_tags, pattern) for pattern in patterns)
        if matched:
            return category
    return None


def _choose_plain_tag_as_category(tags: list[str], default_category: str) -> str | None:
    default_key = _normalize_tag_key(default_category)
    generic_keys = {_normalize_tag_key(key) for key in _GENERIC_CATEGORY_KEYS}
    generic_keys.add(default_key)

    for raw in tags:
        tag = raw.strip()
        if not tag or ":" in tag:
            continue
        key = _normalize_tag_key(tag)
        if key in generic_keys:
            continue
        if re.fullmatch(r"[0-9._/\-]+", tag):
            continue
        return tag
    return None


def _infer_category_from_tags(
    *,
    explicit_tags: list[str],
    auto_tag_candidates: list[str],
    rules: dict | None,
    default_category: str,
    allow_auto_plain_fallback: bool = True,
) -> str | None:
    seen: set[str] = set()
    ordered_tags: list[str] = []
    for raw in [*explicit_tags, *auto_tag_candidates]:
        tag = raw.strip()
        if not tag:
            continue
        key = _normalize_tag_key(tag)
        if key in seen:
            continue
        seen.add(key)
        ordered_tags.append(tag)

    if not ordered_tags:
        return None

    by_rule = _infer_category_from_tag_rules(ordered_tags, rules)
    if by_rule:
        return by_rule

    structured = _extract_structured_tag_map(ordered_tags)
    kind = structured.get("kind", "").strip().lower()
    if kind and kind in _KIND_CATEGORY_MAP:
        return _KIND_CATEGORY_MAP[kind]

    set_key = structured.get("set", "").strip().lower()
    if set_key and set_key in _SET_CATEGORY_MAP:
        return _SET_CATEGORY_MAP[set_key]

    if allow_auto_plain_fallback:
        return _choose_plain_tag_as_category(ordered_tags, default_category)
    return None


def apply_rules(ctx: RuleInput, rules: dict | None) -> RuleOutput:
    rules = rules or {}
    allowed_category_map = _build_allowed_category_map(rules)

    default_category_raw = rules.get("default_category", "기타")
    default_category = default_category_raw.strip() if isinstance(default_category_raw, str) and default_category_raw.strip() else "기타"

    default_key = _normalize_tag_key(default_category)
    if default_key in allowed_category_map:
        default_category = allowed_category_map[default_key]
    else:
        allowed_category_map[default_key] = default_category

    def resolve_allowed_category(raw: str | None) -> str | None:
        if not raw:
            return None
        key = _normalize_tag_key(raw)
        return allowed_category_map.get(key)

    category_rules_raw = rules.get("category_rules", [])
    category_rules = [rule for rule in category_rules_raw if isinstance(rule, dict)] if isinstance(category_rules_raw, list) else []

    review_reasons: list[str] = []

    explicit_tags = [tag.strip() for tag in ctx.caption.explicit_tags if tag.strip()]
    tags = list(explicit_tags)
    auto_tag_candidates: list[str] = []

    sources = {
        "title": ctx.title or "",
        "caption": ctx.caption.caption_raw or "",
        "description": ctx.description or "",
        "filename": ctx.filename or "",
        "body": ctx.body_text or "",
    }

    category = default_category
    category_resolved = False

    # Explicit category from caption (#분류:X)
    if ctx.caption.explicit_category:
        allowed_explicit = resolve_allowed_category(ctx.caption.explicit_category.strip())
        if allowed_explicit:
            category = allowed_explicit
            category_resolved = True
        else:
            review_reasons.append("CATEGORY_OUT_OF_RULESET")

    # Score every rule and pick the strongest.
    if not category_resolved and category_rules:
        candidates: list[_CategoryCandidate] = []
        for idx, rule in enumerate(category_rules):
            scored = _score_rule_against_sources(rule, sources, rule_index=idx)
            if scored:
                candidates.append(scored)

        if candidates:
            candidates.sort(key=lambda c: (c.score, c.priority, -c.rule_index), reverse=True)
            best = candidates[0]
            if best.score >= _MIN_SCORE:
                resolved = resolve_allowed_category(best.category)
                if resolved:
                    category = resolved
                    auto_tag_candidates.extend(best.tags)
                    category_resolved = True
                else:
                    review_reasons.append("CATEGORY_OUT_OF_RULESET")

    # Date detection — try every signal we have, body included.
    date_candidates = [
        ctx.caption.explicit_date,
        ctx.caption.caption_raw,
        ctx.title,
        ctx.filename,
        ctx.metadata_date_text,
        (ctx.body_text or "")[:4000],
        ctx.description,
    ]
    event_date = None
    for candidate in date_candidates:
        parsed = parse_event_date_from_text(candidate, ctx.ingested_at)
        if parsed:
            event_date = parsed
            break
    if event_date is None:
        event_date = ctx.ingested_at.date()
        review_reasons.append("DATE_MISSING")

    # Tag enrichment.
    inferred = infer_structured_tags(
        title=ctx.title,
        description=ctx.description,
        filename=ctx.filename,
        existing_tags=[*tags, *auto_tag_candidates],
    )
    auto_tag_candidates.extend(inferred)
    auto_tag_candidates.extend(
        _extract_keyword_tags(
            title=ctx.title,
            description=ctx.description,
            caption_raw=ctx.caption.caption_raw,
            body_text=ctx.body_text,
            existing_tags=[*tags, *auto_tag_candidates],
        )
    )

    # Structured-tag based inference (kept from prior behaviour).
    if not category_resolved:
        inferred_category = _infer_category_from_tags(
            explicit_tags=explicit_tags,
            auto_tag_candidates=auto_tag_candidates,
            rules=rules,
            default_category=default_category,
            allow_auto_plain_fallback=False,
        )
        if inferred_category and inferred_category.strip():
            allowed_inferred = resolve_allowed_category(inferred_category.strip())
            if allowed_inferred:
                category = allowed_inferred
                category_resolved = True
            elif "CATEGORY_OUT_OF_RULESET" not in review_reasons:
                review_reasons.append("CATEGORY_OUT_OF_RULESET")

    # Extension / MIME fallback before declaring CLASSIFY_FAIL.
    if not category_resolved:
        ext_category = _category_from_extension_or_mime(ctx.filename, ctx.mime_type)
        if ext_category:
            resolved_ext = resolve_allowed_category(ext_category)
            if resolved_ext:
                category = resolved_ext
                category_resolved = True
            else:
                # Even without a matching ruleset entry, prefer a meaningful
                # built-in category over "기타".
                category = ext_category
                allowed_category_map[_normalize_tag_key(ext_category)] = ext_category
                category_resolved = True

    if not category_resolved:
        review_reasons.append("CLASSIFY_FAIL")

    if category and category != default_category:
        auto_tag_candidates.append(category)

    explicit_keys = {_normalize_tag_key(tag) for tag in tags}
    auto_keys: set[str] = set()
    limited_auto_tags: list[str] = []
    for raw in auto_tag_candidates:
        tag = raw.strip()
        if not tag:
            continue
        key = _normalize_tag_key(tag)
        if key in explicit_keys or key in auto_keys:
            continue
        auto_keys.add(key)
        limited_auto_tags.append(tag)
        if len(limited_auto_tags) >= _AUTO_TAG_LIMIT:
            break

    tags = sorted(set([*tags, *limited_auto_tags]))
    return RuleOutput(category=category, tags=tags, event_date=event_date, review_reasons=review_reasons)
