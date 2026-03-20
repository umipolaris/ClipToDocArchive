from app.api.v1 import routes_admin_backup


def test_capture_consistency_marker_tracks_recent_feature_tables(monkeypatch):
    counts = {
        "document_categories": 4,
        "dashboard_milestones": 6,
        "dashboard_tasks": 7,
        "dashboard_task_settings": 1,
        "security_policies": 1,
        "branding_settings": 1,
        "document_comments": 5,
        "ingest_jobs": 3,
        "ingest_events": 9,
    }

    def fake_count(_db, model):  # type: ignore[no-untyped-def]
        return counts.get(model.__tablename__, 0)

    def fake_max(_db, model):  # type: ignore[no-untyped-def]
        return f"{model.__tablename__}-max"

    monkeypatch.setattr(routes_admin_backup, "_marker_count", fake_count)
    monkeypatch.setattr(routes_admin_backup, "_marker_max_updated_at", fake_max)

    marker = routes_admin_backup._capture_consistency_marker(db=None)  # type: ignore[arg-type]

    assert marker["document_categories_count"] == 4
    assert marker["dashboard_milestones_count"] == 6
    assert marker["dashboard_tasks_count"] == 7
    assert marker["dashboard_task_settings_count"] == 1
    assert marker["security_policies_count"] == 1
    assert marker["branding_settings_count"] == 1
    assert marker["document_comments_count"] == 5
    assert marker["ingest_jobs_count"] == 3
    assert marker["ingest_events_count"] == 9
    assert marker["document_categories_max_updated_at"] == "document_categories-max"
    assert marker["dashboard_milestones_max_updated_at"] == "dashboard_milestones-max"
    assert marker["dashboard_tasks_max_updated_at"] == "dashboard_tasks-max"
    assert marker["security_policies_max_updated_at"] == "security_policies-max"
    assert marker["branding_settings_max_updated_at"] == "branding_settings-max"
