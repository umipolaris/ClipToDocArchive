from app.api.v1.routes_documents import _build_manual_post_category_options
from app.services.rule_categories import extract_categories_from_rules_json


def test_extract_categories_from_rules_json_uses_active_rule_order_and_dedupes():
    rules = {
        "default_category": "기타",
        "category_rules": [
            {"category": "문서통제"},
            {"category": "회의"},
            {"category": "문서통제"},
        ],
        "tag_category_rules": [
            {"category": "도면"},
            {"category": "회의"},
            {"category": "내부자료"},
        ],
    }

    out = extract_categories_from_rules_json(rules)

    assert out == ["문서통제", "회의", "도면", "내부자료", "기타"]


def test_extract_categories_from_rules_json_falls_back_to_default():
    assert extract_categories_from_rules_json({}) == ["기타"]
    assert extract_categories_from_rules_json(None) == ["기타"]


def test_extract_categories_from_rules_json_ignores_malformed_values():
    rules = {
        "default_category": "기타",
        "category_rules": "broken",
        "tag_category_rules": [None, {"category": ""}, {"category": 123}, {"category": "문서통제"}],
    }

    out = extract_categories_from_rules_json(rules)

    assert out == ["문서통제", "기타"]


def test_build_manual_post_category_options_merges_rule_and_db_categories_without_duplicates():
    out = _build_manual_post_category_options(
        ["회의", "문서통제", "기타"],
        ["새카테고리", "회의", "현장기록"],
    )

    assert out == ["회의", "문서통제", "기타", "새카테고리", "현장기록"]
