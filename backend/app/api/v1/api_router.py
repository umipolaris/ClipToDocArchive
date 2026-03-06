from fastapi import APIRouter

from app.api.v1.routes_archive import router as archive_router
from app.api.v1.routes_admin_backup import router as admin_backup_router
from app.api.v1.routes_admin_logs import router as admin_logs_router
from app.api.v1.routes_branding import router as branding_router
from app.api.v1.routes_documents import router as documents_router
from app.api.v1.routes_dashboard import router as dashboard_router
from app.api.v1.routes_auth import router as auth_router
from app.api.v1.routes_health import router as health_router
from app.api.v1.routes_ingest import router as ingest_router
from app.api.v1.routes_mindmap import router as mindmap_router
from app.api.v1.routes_review_queue import router as review_router
from app.api.v1.routes_rules import router as rules_router
from app.api.v1.routes_saved_filters import router as saved_filters_router
from app.api.v1.routes_timeline import router as timeline_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(ingest_router)
api_router.include_router(archive_router)
api_router.include_router(dashboard_router)
api_router.include_router(documents_router)
api_router.include_router(timeline_router)
api_router.include_router(mindmap_router)
api_router.include_router(review_router)
api_router.include_router(rules_router)
api_router.include_router(saved_filters_router)
api_router.include_router(branding_router)
api_router.include_router(admin_backup_router)
api_router.include_router(admin_logs_router)
api_router.include_router(health_router)
