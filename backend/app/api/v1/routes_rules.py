import hashlib
import json
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, require_roles
from app.db.models import AuditLog, Category, Document, DocumentFile, DocumentTag, File, Ruleset, RuleVersion, Tag
from app.db.models import UserRole
from app.db.session import get_db
from app.schemas.rule import (
    BackfillAcceptedResponse,
    BackfillRequest,
    RuleConflictItem,
    RuleConflictResponse,
    RuleSimulationRequest,
    RuleSimulationResponse,
    RuleSimulationSample,
    RulesImportResponse,
    RuleTestRequest,
    RuleTestResponse,
    RuleVersionActivateResponse,
    RuleVersionCreateRequest,
    RuleVersionDetailResponse,
    RuleVersionSummary,
    RulesImportRequest,
    RulesetCreateRequest,
    RulesetDetailResponse,
    RulesetExportResponse,
    RulesetSummary,
    RulesetsListResponse,
    RulesetUpdateRequest,
)
from app.services.backfill_service import _select_documents
from app.services.caption_parser import parse_caption
from app.services.rule_engine import RuleInput, apply_rules
from app.worker.tasks_ingest import run_backfill_task

router = APIRouter()


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _rules_checksum(rules_json: dict) -> str:
    payload = json.dumps(rules_json, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _to_ruleset_summary(ruleset: Ruleset) -> RulesetSummary:
    return RulesetSummary(
        id=ruleset.id,
        name=ruleset.name,
        description=ruleset.description,
        is_active=ruleset.is_active,
        current_version_id=ruleset.current_version_id,
        created_at=ruleset.created_at,
        updated_at=ruleset.updated_at,
    )


def _to_rule_version_summary(rv: RuleVersion) -> RuleVersionSummary:
    return RuleVersionSummary(
        id=rv.id,
        ruleset_id=rv.ruleset_id,
        version_no=rv.version_no,
        is_active=rv.is_active,
        published_at=rv.published_at,
        created_at=rv.created_at,
    )


def _to_rule_version_detail(rv: RuleVersion) -> RuleVersionDetailResponse:
    return RuleVersionDetailResponse(
        id=rv.id,
        ruleset_id=rv.ruleset_id,
        version_no=rv.version_no,
        rules_json=rv.rules_json,
        checksum_sha256=rv.checksum_sha256,
        is_active=rv.is_active,
        published_at=rv.published_at,
        created_at=rv.created_at,
    )


def _get_document_tags_map(db: Session, document_ids: list[UUID]) -> dict[UUID, list[str]]:
    if not document_ids:
        return {}
    rows = db.execute(
        select(DocumentTag.document_id, Tag.name)
        .join(Tag, Tag.id == DocumentTag.tag_id)
        .where(DocumentTag.document_id.in_(document_ids))
        .order_by(DocumentTag.document_id.asc(), Tag.name.asc())
    ).all()
    out: dict[UUID, list[str]] = {}
    for document_id, name in rows:
        out.setdefault(document_id, []).append(name)
    return out


def _get_primary_filename_map(db: Session, document_ids: list[UUID]) -> dict[UUID, str]:
    if not document_ids:
        return {}
    rows = db.execute(
        select(DocumentFile.document_id, func.coalesce(DocumentFile.display_filename, File.original_filename))
        .join(File, File.id == DocumentFile.file_id)
        .where(DocumentFile.document_id.in_(document_ids))
        .order_by(DocumentFile.document_id.asc(), DocumentFile.is_primary.desc(), DocumentFile.created_at.desc())
    ).all()
    out: dict[UUID, str] = {}
    for document_id, filename in rows:
        out.setdefault(document_id, filename)
    return out


def _detect_rule_conflicts(rules_json: dict) -> list[RuleConflictItem]:
    category_rules = rules_json.get("category_rules", []) if isinstance(rules_json, dict) else []
    keyword_map: dict[tuple[str, str], set[str]] = {}
    for rule in category_rules:
        if not isinstance(rule, dict):
            continue
        category = str(rule.get("category") or "").strip() or "UNKNOWN"
        keywords_group = rule.get("keywords")
        if not isinstance(keywords_group, dict):
            continue
        for source_field in ("title", "description", "filename", "body"):
            keywords = keywords_group.get(source_field, [])
            if not isinstance(keywords, list):
                continue
            for raw in keywords:
                keyword = str(raw).strip().lower()
                if not keyword:
                    continue
                keyword_map.setdefault((source_field, keyword), set()).add(category)

    conflicts: list[RuleConflictItem] = []
    for (source_field, keyword), categories in sorted(keyword_map.items(), key=lambda x: (x[0][0], x[0][1])):
        if len(categories) <= 1:
            continue
        conflicts.append(
            RuleConflictItem(
                source_field=source_field,
                keyword=keyword,
                categories=sorted(categories),
            )
        )
    return conflicts


@router.get("/rulesets", response_model=RulesetsListResponse)
def list_rulesets(
    _: CurrentUser = Depends(require_roles(UserRole.REVIEWER, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RulesetsListResponse:
    rows = db.execute(select(Ruleset).order_by(Ruleset.created_at.desc())).scalars().all()
    return RulesetsListResponse(items=[_to_ruleset_summary(row) for row in rows])


@router.post("/rulesets", response_model=RulesetSummary, status_code=status.HTTP_201_CREATED)
def create_ruleset(
    req: RulesetCreateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RulesetSummary:
    existing = db.execute(select(Ruleset).where(Ruleset.name == req.name)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="ruleset already exists")

    ruleset = Ruleset(name=req.name, description=req.description, is_active=True, created_by=current_user.id)
    db.add(ruleset)
    db.commit()
    db.refresh(ruleset)

    db.add(
        AuditLog(
            action="RULESET_CREATE",
            target_type="ruleset",
            target_id=ruleset.id,
            actor_user_id=current_user.id,
            after_json={"name": ruleset.name, "description": ruleset.description},
        )
    )
    db.commit()

    return _to_ruleset_summary(ruleset)


@router.patch("/rulesets/{ruleset_id}", response_model=RulesetSummary)
def update_ruleset(
    ruleset_id: UUID,
    req: RulesetUpdateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RulesetSummary:
    ruleset = db.get(Ruleset, ruleset_id)
    if not ruleset:
        raise HTTPException(status_code=404, detail="ruleset not found")

    before_json = {
        "description": ruleset.description,
        "is_active": ruleset.is_active,
    }

    if req.description is not None:
        ruleset.description = req.description
    if req.is_active is not None:
        ruleset.is_active = req.is_active

    db.add(ruleset)
    db.commit()
    db.refresh(ruleset)

    db.add(
        AuditLog(
            action="RULESET_UPDATE",
            target_type="ruleset",
            target_id=ruleset.id,
            actor_user_id=current_user.id,
            before_json=before_json,
            after_json={
                "description": ruleset.description,
                "is_active": ruleset.is_active,
            },
        )
    )
    db.commit()

    return _to_ruleset_summary(ruleset)


@router.get("/rulesets/{ruleset_id}", response_model=RulesetDetailResponse)
def get_ruleset_detail(
    ruleset_id: UUID,
    _: CurrentUser = Depends(require_roles(UserRole.REVIEWER, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RulesetDetailResponse:
    ruleset = db.get(Ruleset, ruleset_id)
    if not ruleset:
        raise HTTPException(status_code=404, detail="ruleset not found")

    versions = db.execute(
        select(RuleVersion)
        .where(RuleVersion.ruleset_id == ruleset.id)
        .order_by(RuleVersion.version_no.desc())
    ).scalars().all()

    return RulesetDetailResponse(
        ruleset=_to_ruleset_summary(ruleset),
        versions=[_to_rule_version_summary(v) for v in versions],
    )


@router.post(
    "/rulesets/{ruleset_id}/versions",
    response_model=RuleVersionSummary,
    status_code=status.HTTP_201_CREATED,
)
def create_rule_version(
    ruleset_id: UUID,
    req: RuleVersionCreateRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RuleVersionSummary:
    ruleset = db.get(Ruleset, ruleset_id)
    if not ruleset:
        raise HTTPException(status_code=404, detail="ruleset not found")

    max_version_no = db.execute(
        select(func.coalesce(func.max(RuleVersion.version_no), 0)).where(RuleVersion.ruleset_id == ruleset_id)
    ).scalar_one()

    rv = RuleVersion(
        ruleset_id=ruleset_id,
        version_no=int(max_version_no) + 1,
        rules_json=req.rules_json,
        checksum_sha256=_rules_checksum(req.rules_json),
        is_active=False,
        created_by=current_user.id,
    )
    db.add(rv)
    db.commit()
    db.refresh(rv)

    db.add(
        AuditLog(
            action="RULE_VERSION_CREATE",
            target_type="rule_version",
            target_id=rv.id,
            actor_user_id=current_user.id,
            after_json={
                "ruleset_id": str(ruleset_id),
                "version_no": rv.version_no,
                "checksum_sha256": rv.checksum_sha256,
            },
        )
    )
    db.commit()

    return _to_rule_version_summary(rv)


@router.get("/rule-versions/{rule_version_id}", response_model=RuleVersionDetailResponse)
def get_rule_version(
    rule_version_id: UUID,
    _: CurrentUser = Depends(require_roles(UserRole.REVIEWER, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RuleVersionDetailResponse:
    rv = db.get(RuleVersion, rule_version_id)
    if not rv:
        raise HTTPException(status_code=404, detail="rule version not found")
    return _to_rule_version_detail(rv)


@router.post(
    "/rule-versions/{rule_version_id}/activate",
    response_model=RuleVersionActivateResponse,
)
def activate_rule_version(
    rule_version_id: UUID,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RuleVersionActivateResponse:
    rv = db.get(RuleVersion, rule_version_id)
    if not rv:
        raise HTTPException(status_code=404, detail="rule version not found")

    ruleset = db.get(Ruleset, rv.ruleset_id)
    if not ruleset:
        raise HTTPException(status_code=404, detail="ruleset not found")

    rows = db.execute(
        select(RuleVersion)
        .where(RuleVersion.ruleset_id == rv.ruleset_id)
        .order_by(RuleVersion.version_no.asc())
    ).scalars().all()

    for row in rows:
        row.is_active = False

    rv.is_active = True
    rv.published_at = _now()
    ruleset.current_version_id = rv.id

    db.add(rv)
    db.add(ruleset)
    db.commit()

    db.add(
        AuditLog(
            action="RULE_VERSION_ACTIVATE",
            target_type="rule_version",
            target_id=rv.id,
            actor_user_id=current_user.id,
            after_json={
                "ruleset_id": str(rv.ruleset_id),
                "version_no": rv.version_no,
                "published_at": rv.published_at.isoformat(),
            },
        )
    )
    db.commit()

    return RuleVersionActivateResponse(
        rule_version_id=rv.id,
        ruleset_id=rv.ruleset_id,
        published_at=rv.published_at,
        is_active=rv.is_active,
    )


@router.get("/rulesets/{ruleset_id}/export", response_model=RulesetExportResponse)
def export_ruleset(
    ruleset_id: UUID,
    _: CurrentUser = Depends(require_roles(UserRole.REVIEWER, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RulesetExportResponse:
    ruleset = db.get(Ruleset, ruleset_id)
    if not ruleset:
        raise HTTPException(status_code=404, detail="ruleset not found")

    versions = db.execute(
        select(RuleVersion)
        .where(RuleVersion.ruleset_id == ruleset.id)
        .order_by(RuleVersion.version_no.asc())
    ).scalars().all()

    return RulesetExportResponse(
        ruleset=_to_ruleset_summary(ruleset),
        versions=[_to_rule_version_detail(v) for v in versions],
    )


@router.post("/rules/import", response_model=RulesImportResponse, status_code=status.HTTP_201_CREATED)
def import_rules(
    req: RulesImportRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RulesImportResponse:
    if not req.versions:
        raise HTTPException(status_code=400, detail="versions must not be empty")

    existing = db.execute(select(Ruleset).where(Ruleset.name == req.ruleset_name)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="ruleset already exists")

    ruleset = Ruleset(
        name=req.ruleset_name,
        description=req.description,
        is_active=True,
        created_by=current_user.id,
    )
    db.add(ruleset)
    db.commit()
    db.refresh(ruleset)

    imported: list[RuleVersion] = []
    for idx, raw in enumerate(req.versions, start=1):
        rules_json = raw.get("rules_json") if isinstance(raw, dict) and "rules_json" in raw else raw
        if not isinstance(rules_json, dict):
            raise HTTPException(status_code=400, detail=f"invalid rules_json at index {idx - 1}")

        rv = RuleVersion(
            ruleset_id=ruleset.id,
            version_no=idx,
            rules_json=rules_json,
            checksum_sha256=_rules_checksum(rules_json),
            is_active=False,
            created_by=current_user.id,
        )
        db.add(rv)
        db.flush()
        imported.append(rv)

    activated_version_id: UUID | None = None
    if req.activate_latest and imported:
        latest = imported[-1]
        latest.is_active = True
        latest.published_at = _now()
        ruleset.current_version_id = latest.id
        activated_version_id = latest.id

    db.add(ruleset)
    db.commit()

    db.add(
        AuditLog(
            action="RULES_IMPORT",
            target_type="ruleset",
            target_id=ruleset.id,
            actor_user_id=current_user.id,
            after_json={
                "imported_versions": len(imported),
                "activate_latest": req.activate_latest,
                "activated_version_id": str(activated_version_id) if activated_version_id else None,
            },
        )
    )
    db.commit()

    return RulesImportResponse(
        ruleset_id=ruleset.id,
        imported_versions=len(imported),
        activated_version_id=activated_version_id,
    )


@router.post("/rules/test", response_model=RuleTestResponse)
def test_rules(
    req: RuleTestRequest,
    _: CurrentUser = Depends(require_roles(UserRole.REVIEWER, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RuleTestResponse:
    rv = db.execute(select(RuleVersion).where(RuleVersion.id == req.rule_version_id)).scalar_one_or_none()
    if not rv:
        raise HTTPException(status_code=404, detail="rule version not found")

    sample = req.sample
    filename = sample.filename or "sample.txt"
    caption = parse_caption(sample.caption, filename)

    out = apply_rules(
        RuleInput(
            caption=caption,
            title=sample.title or caption.title,
            description=sample.description or caption.description,
            filename=filename,
            body_text=sample.body_text or "",
            metadata_date_text=None,
            ingested_at=_now(),
        ),
        rv.rules_json,
    )

    return RuleTestResponse(
        category=out.category,
        tags=out.tags,
        event_date=out.event_date,
        review_needed=len(out.review_reasons) > 0,
    )


@router.post("/rules/simulate/batch", response_model=RuleSimulationResponse)
def simulate_rules_batch(
    req: RuleSimulationRequest,
    _: CurrentUser = Depends(require_roles(UserRole.REVIEWER, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RuleSimulationResponse:
    rv = db.execute(select(RuleVersion).where(RuleVersion.id == req.rule_version_id)).scalar_one_or_none()
    if not rv:
        raise HTTPException(status_code=404, detail="rule version not found")

    baseline_rv = None
    if req.baseline_rule_version_id:
        baseline_rv = db.execute(
            select(RuleVersion).where(RuleVersion.id == req.baseline_rule_version_id)
        ).scalar_one_or_none()
        if not baseline_rv:
            raise HTTPException(status_code=404, detail="baseline rule version not found")

    limit = max(1, min(1000, int(req.limit)))
    filter_payload = req.filter.model_dump(by_alias=True, mode="json") if req.filter else None
    docs = db.execute(_select_documents(filter_payload).limit(limit)).scalars().all()

    doc_ids = [doc.id for doc in docs]
    tag_map = _get_document_tags_map(db, doc_ids)
    filename_map = _get_primary_filename_map(db, doc_ids)
    category_map = {
        row.id: row.name
        for row in db.execute(
            select(Category.id, Category.name).where(Category.id.in_([doc.category_id for doc in docs if doc.category_id]))
        ).all()
    }

    changed = 0
    samples: list[RuleSimulationSample] = []
    for doc in docs:
        filename = filename_map.get(doc.id, "unknown.bin")
        caption = parse_caption(doc.caption_raw, filename)
        input_ctx = RuleInput(
            caption=caption,
            title=doc.title,
            description=doc.description,
            filename=filename,
            body_text="",
            metadata_date_text=None,
            ingested_at=doc.ingested_at,
        )
        predicted = apply_rules(input_ctx, rv.rules_json)
        current_category = category_map.get(doc.category_id) if doc.category_id else None
        current_tags = sorted(tag_map.get(doc.id, []))

        if baseline_rv:
            baseline_out = apply_rules(input_ctx, baseline_rv.rules_json)
            baseline_category = baseline_out.category
            baseline_event_date = baseline_out.event_date
            baseline_tags = sorted(baseline_out.tags)
        else:
            baseline_category = current_category
            baseline_event_date = doc.event_date
            baseline_tags = current_tags

        changed_fields: list[str] = []
        if baseline_category != predicted.category:
            changed_fields.append("category")
        if baseline_event_date != predicted.event_date:
            changed_fields.append("event_date")
        if baseline_tags != sorted(predicted.tags):
            changed_fields.append("tags")
        predicted_review = len(predicted.review_reasons) > 0
        baseline_review = doc.review_status.value == "NEEDS_REVIEW"
        if baseline_review != predicted_review:
            changed_fields.append("review_needed")

        is_changed = len(changed_fields) > 0
        if is_changed:
            changed += 1

        if len(samples) < 100:
            samples.append(
                RuleSimulationSample(
                    document_id=doc.id,
                    title=doc.title,
                    current_category=baseline_category,
                    predicted_category=predicted.category,
                    current_event_date=baseline_event_date,
                    predicted_event_date=predicted.event_date,
                    current_tags=baseline_tags,
                    predicted_tags=sorted(predicted.tags),
                    changed=is_changed,
                    changed_fields=changed_fields,
                )
            )

    return RuleSimulationResponse(
        rule_version_id=rv.id,
        baseline_rule_version_id=baseline_rv.id if baseline_rv else None,
        scanned=len(docs),
        changed=changed,
        unchanged=len(docs) - changed,
        samples=samples,
        generated_at=_now(),
    )


@router.get("/rules/conflicts/{rule_version_id}", response_model=RuleConflictResponse)
def detect_rule_conflicts(
    rule_version_id: UUID,
    _: CurrentUser = Depends(require_roles(UserRole.REVIEWER, UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> RuleConflictResponse:
    rv = db.execute(select(RuleVersion).where(RuleVersion.id == rule_version_id)).scalar_one_or_none()
    if not rv:
        raise HTTPException(status_code=404, detail="rule version not found")

    conflicts = _detect_rule_conflicts(rv.rules_json)
    return RuleConflictResponse(
        rule_version_id=rv.id,
        total_conflicts=len(conflicts),
        conflicts=conflicts,
    )


@router.post("/rules/backfill", response_model=BackfillAcceptedResponse, status_code=202)
def trigger_backfill(
    req: BackfillRequest,
    current_user: CurrentUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> BackfillAcceptedResponse:
    rv = db.execute(select(RuleVersion).where(RuleVersion.id == req.rule_version_id)).scalar_one_or_none()
    if not rv:
        raise HTTPException(status_code=404, detail="rule version not found")

    backfill_job_id = str(uuid4())
    run_backfill_task.delay(
        {
            "backfill_job_id": backfill_job_id,
            "rule_version_id": str(req.rule_version_id),
            "filter": req.filter.model_dump(by_alias=True, mode="json") if req.filter else None,
            "batch_size": req.batch_size,
            "requested_at": _now().isoformat(),
        }
    )

    db.add(
        AuditLog(
            action="BACKFILL_REQUEST",
            target_type="rule_version",
            target_id=rv.id,
            actor_user_id=current_user.id,
            after_json={
                "backfill_job_id": backfill_job_id,
                "batch_size": req.batch_size,
                "filter": req.filter.model_dump(by_alias=True, mode="json") if req.filter else None,
            },
        )
    )
    db.commit()

    return BackfillAcceptedResponse(job_id=backfill_job_id, status="accepted")
