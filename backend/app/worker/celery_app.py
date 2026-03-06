from celery import Celery
from celery.schedules import crontab

from app.core.config import get_settings

settings = get_settings()

celery_app = Celery(
    "doc_archive",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.worker.tasks_ingest", "app.worker.tasks_search", "app.worker.tasks_reports", "app.worker.tasks_backup"],
)

celery_app.conf.update(
    task_acks_late=True,
    task_track_started=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    broker_connection_retry_on_startup=True,
    task_routes={
        "app.worker.tasks_ingest.process_ingest_job_task": {"queue": "ingest"},
        "app.worker.tasks_ingest.run_backfill_task": {"queue": "backfill"},
        "app.worker.tasks_search.sync_document_index_task": {"queue": "search"},
        "app.worker.tasks_search.sync_documents_index_batch_task": {"queue": "search"},
        "app.worker.tasks_search.delete_document_index_task": {"queue": "search"},
        "app.worker.tasks_search.rebuild_documents_index_task": {"queue": "search"},
        "app.worker.tasks_reports.generate_weekly_ops_report_task": {"queue": "reports"},
        "app.worker.tasks_backup.run_scheduled_full_backup_task": {"queue": "reports"},
    },
    beat_schedule={
        "weekly-ops-report": {
            "task": "app.worker.tasks_reports.generate_weekly_ops_report_task",
            "schedule": crontab(minute=15, hour=0, day_of_week="mon"),
            "kwargs": {"days": 7},
        },
        "scheduled-full-backup-check": {
            "task": "app.worker.tasks_backup.run_scheduled_full_backup_task",
            "schedule": crontab(minute="*"),
        },
    },
)
