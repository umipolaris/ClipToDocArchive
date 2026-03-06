from datetime import datetime, timedelta, timezone
from time import perf_counter

from fastapi import FastAPI
from prometheus_client import Counter, Gauge, Histogram, generate_latest
from sqlalchemy import func, select
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import JSONResponse, Response

from app.api.v1.api_router import api_router
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.models import IngestJob, IngestState
from app.db.session import SessionLocal

settings = get_settings()
configure_logging()

app = FastAPI(title=settings.app_name)
app.include_router(api_router, prefix=settings.api_prefix)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret,
    session_cookie=settings.session_cookie_name,
    max_age=settings.session_cookie_max_age_seconds,
    same_site=settings.session_same_site,
    https_only=settings.session_https_only,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

http_requests = Counter("http_requests_total", "Total HTTP requests")
http_request_duration_seconds = Histogram("http_request_duration_seconds", "HTTP request duration in seconds")
search_request_duration_seconds = Histogram(
    "search_request_duration_seconds",
    "Document search/list response duration in seconds",
    buckets=(0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 2.0, 3.0, 5.0),
)
ingest_success_rate_1h = Gauge("ingest_success_rate_1h", "Ingest success ratio over last hour")
ingest_jobs_backlog = Gauge("ingest_jobs_backlog", "Number of pending ingest jobs")
ingest_oldest_pending_seconds = Gauge("ingest_oldest_pending_seconds", "Age of oldest pending ingest job in seconds")
READ_ONLY_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
READ_ONLY_ALLOWED_PATHS = {f"{settings.api_prefix}/auth/login", f"{settings.api_prefix}/auth/logout"}


def _refresh_operational_metrics() -> None:
    pending_states = [
        IngestState.RECEIVED,
        IngestState.STORED,
        IngestState.EXTRACTED,
        IngestState.CLASSIFIED,
        IngestState.INDEXED,
    ]
    window_start = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    with SessionLocal() as db:
        backlog = (
            db.execute(select(func.count(IngestJob.id)).where(IngestJob.state.in_(pending_states)))
            .scalar_one()
        )
        ingest_jobs_backlog.set(float(backlog))

        oldest_pending = (
            db.execute(
                select(IngestJob.received_at)
                .where(IngestJob.state.in_(pending_states))
                .order_by(IngestJob.received_at.asc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        if oldest_pending:
            age_sec = (datetime.now(tz=timezone.utc) - oldest_pending).total_seconds()
            ingest_oldest_pending_seconds.set(max(0.0, age_sec))
        else:
            ingest_oldest_pending_seconds.set(0.0)

        success_count = (
            db.execute(
                select(func.count(IngestJob.id)).where(
                    IngestJob.finished_at >= window_start,
                    IngestJob.state.in_([IngestState.PUBLISHED, IngestState.NEEDS_REVIEW]),
                )
            )
            .scalar_one()
        )
        failed_count = (
            db.execute(
                select(func.count(IngestJob.id)).where(
                    IngestJob.finished_at >= window_start,
                    IngestJob.state == IngestState.FAILED,
                )
            )
            .scalar_one()
        )
        total_count = success_count + failed_count
        rate = (success_count / total_count) if total_count > 0 else 1.0
        ingest_success_rate_1h.set(float(rate))


@app.middleware("http")
async def metrics_middleware(request, call_next):  # noqa: ANN001, ANN201
    http_requests.inc()
    start = perf_counter()
    response = await call_next(request)
    elapsed = perf_counter() - start
    http_request_duration_seconds.observe(elapsed)
    path = request.url.path
    if request.method.upper() == "GET" and path.startswith(f"{settings.api_prefix}/documents"):
        search_request_duration_seconds.observe(elapsed)
    return response


@app.middleware("http")
async def read_only_middleware(request, call_next):  # noqa: ANN001, ANN201
    if not settings.read_only_mode:
        return await call_next(request)

    path = request.url.path
    if not path.startswith(settings.api_prefix):
        return await call_next(request)

    method = request.method.upper()
    if method in READ_ONLY_SAFE_METHODS:
        return await call_next(request)
    if path in READ_ONLY_ALLOWED_PATHS:
        return await call_next(request)

    return JSONResponse(status_code=503, content={"detail": "read-only mode enabled"})


@app.get("/metrics")
def metrics() -> Response:
    try:
        _refresh_operational_metrics()
    except Exception:
        # metrics endpoint should stay available even when DB is temporarily unavailable
        pass
    return Response(generate_latest(), media_type="text/plain")
