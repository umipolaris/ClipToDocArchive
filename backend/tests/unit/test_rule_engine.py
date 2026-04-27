from datetime import datetime, timezone

from app.services.caption_parser import parse_caption
from app.services.rule_engine import RuleInput, apply_rules


RULES = {
    "default_category": "기타",
    "category_rules": [
        {
            "category": "회의",
            "keywords": {
                "title": ["회의", "meeting"],
                "description": ["의사결정"],
                "filename": ["minutes"],
                "body": ["회의록"],
            },
            "tags": ["회의"],
        }
    ],
}


def test_priority_explicit_category_first_when_category_in_ruleset():
    caption = parse_caption("제목\n설명\n#분류:회의", "a.pdf")
    out = apply_rules(
        RuleInput(
            caption=caption,
            title=caption.title,
            description=caption.description,
            filename="a.pdf",
            body_text="",
            metadata_date_text=None,
            ingested_at=datetime(2026, 2, 24, tzinfo=timezone.utc),
        ),
        RULES,
    )
    assert out.category == "회의"


def test_explicit_category_outside_ruleset_falls_back_to_extension():
    caption = parse_caption("제목\n설명\n#분류:계약", "a.pdf")
    out = apply_rules(
        RuleInput(
            caption=caption,
            title=caption.title,
            description=caption.description,
            filename="a.pdf",
            body_text="",
            metadata_date_text=None,
            ingested_at=datetime(2026, 2, 24, tzinfo=timezone.utc),
        ),
        RULES,
    )
    # Explicit category is rejected (not in ruleset) → flag, but extension
    # now provides a sensible category instead of falling all the way to "기타".
    assert out.category == "문서"
    assert "CATEGORY_OUT_OF_RULESET" in out.review_reasons
    assert "CLASSIFY_FAIL" not in out.review_reasons


def test_fallback_to_default_and_review():
    caption = parse_caption("무관한 제목\n무관한 내용", "x.bin")
    out = apply_rules(
        RuleInput(
            caption=caption,
            title=caption.title,
            description=caption.description,
            filename="x.bin",
            body_text="",
            metadata_date_text=None,
            ingested_at=datetime(2026, 2, 24, tzinfo=timezone.utc),
        ),
        RULES,
    )
    assert out.category == "기타"
    assert "CLASSIFY_FAIL" in out.review_reasons


def test_apply_rules_adds_structured_tags_from_title():
    caption = parse_caption("Document Control Procedure rev.2\n운영 절차", "dcp_rev2.pdf")
    out = apply_rules(
        RuleInput(
            caption=caption,
            title=caption.title,
            description=caption.description,
            filename="dcp_rev2.pdf",
            body_text="",
            metadata_date_text=None,
            ingested_at=datetime(2026, 2, 24, tzinfo=timezone.utc),
        ),
        RULES,
    )

    assert "set:dcp" in out.tags
    assert "dockey:document-control-procedure" in out.tags
    assert "rev:2" in out.tags


def test_apply_rules_adds_keyword_tags_from_text():
    caption = parse_caption("주간 운영회의\n포털 계정 점검 및 일정 공유", "meeting_note.txt")
    out = apply_rules(
        RuleInput(
            caption=caption,
            title=caption.title,
            description=caption.description,
            filename="meeting_note.txt",
            body_text="",
            metadata_date_text=None,
            ingested_at=datetime(2026, 2, 24, tzinfo=timezone.utc),
        ),
        RULES,
    )

    assert "회의" in out.tags
    assert len(out.tags) <= 3
    assert out.tags == ["운영회의", "주간", "회의"]


def test_apply_rules_handles_malformed_rules_gracefully():
    caption = parse_caption("월간 점검 보고\n포털 운영 상태", "status_report.txt")
    out = apply_rules(
        RuleInput(
            caption=caption,
            title=caption.title,
            description=caption.description,
            filename="status_report.txt",
            body_text="",
            metadata_date_text=None,
            ingested_at=datetime(2026, 2, 24, tzinfo=timezone.utc),
        ),
        {"default_category": "기타", "category_rules": "broken"},
    )

    # Malformed ruleset → no keyword scoring, but .txt extension still
    # provides a sensible category instead of "기타".
    assert out.category == "문서"
    assert len(out.tags) <= 3


def test_apply_rules_does_not_infer_category_from_explicit_tags_when_no_keyword_match():
    caption = parse_caption("점검 공지\n운영 상태 공유\n#태그:운영회의,주간", "ops_note.txt")
    out = apply_rules(
        RuleInput(
            caption=caption,
            title=caption.title,
            description=caption.description,
            filename="ops_note.txt",
            body_text="",
            metadata_date_text=None,
            ingested_at=datetime(2026, 2, 24, tzinfo=timezone.utc),
        ),
        RULES,
    )

    # No keyword match → still doesn't infer category from explicit tags,
    # but .txt extension provides a sensible "문서" instead of "기타".
    # CLASSIFY_FAIL is no longer raised since extension fallback resolved it.
    assert out.category == "문서"
    assert "CLASSIFY_FAIL" not in out.review_reasons


def test_apply_rules_infers_category_from_tag_category_rules():
    caption = parse_caption("Document Control Procedure rev.2\n운영 절차", "dcp_rev2.pdf")
    out = apply_rules(
        RuleInput(
            caption=caption,
            title=caption.title,
            description=caption.description,
            filename="dcp_rev2.pdf",
            body_text="",
            metadata_date_text=None,
            ingested_at=datetime(2026, 2, 24, tzinfo=timezone.utc),
        ),
        {
            "default_category": "기타",
            "category_rules": [],
            "tag_category_rules": [{"category": "문서통제", "tags": ["set:dcp"]}],
        },
    )

    assert out.category == "문서통제"
    assert "CLASSIFY_FAIL" not in out.review_reasons
