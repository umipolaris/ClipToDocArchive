from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, get_current_user, require_roles
from app.core.config import get_settings
from app.core.security import hash_password, validate_password_strength, verify_password
from app.db.models import (
    AuditLog,
    BackupScheduleSetting,
    BrandingSetting,
    Category,
    Document,
    DocumentCategory,
    DocumentFile,
    DocumentTag,
    DocumentVersion,
    File,
    IngestEvent,
    IngestJob,
    RuleVersion,
    Ruleset,
    SavedFilter,
    SecurityPolicy,
    Tag,
    User,
    UserRole,
)
from app.db.session import get_db
from app.schemas.auth import (
    AuthSecurityPolicy,
    AuthUser,
    ChangePasswordRequest,
    ChangePasswordResponse,
    CreateUserRequest,
    DeleteUserResponse,
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    UpdateAuthSecurityPolicyRequest,
    UpdateUserRequest,
    UserSummary,
    UsersListResponse,
)

router = APIRouter()
settings = get_settings()


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _to_auth_policy_response(row: SecurityPolicy) -> AuthSecurityPolicy:
    return AuthSecurityPolicy(
        scope=row.scope,
        password_min_length=row.password_min_length,
        require_uppercase=row.require_uppercase,
        require_lowercase=row.require_lowercase,
        require_digit=row.require_digit,
        require_special=row.require_special,
        max_failed_attempts=row.max_failed_attempts,
        lockout_seconds=row.lockout_seconds,
        auto_login_days=row.auto_login_days,
        updated_at=row.updated_at,
    )


def _get_auth_policy(db: Session) -> AuthSecurityPolicy:
    row = db.get(SecurityPolicy, "auth")
    if row:
        return _to_auth_policy_response(row)
    return AuthSecurityPolicy(
        scope="auth",
        password_min_length=settings.password_min_length,
        require_uppercase=True,
        require_lowercase=True,
        require_digit=True,
        require_special=True,
        max_failed_attempts=settings.auth_max_failed_attempts,
        lockout_seconds=settings.auth_lockout_seconds,
        auto_login_days=settings.auth_auto_login_days,
        updated_at=None,
    )


def _ensure_password_strength(password: str, db: Session) -> None:
    policy = _get_auth_policy(db)
    errors = validate_password_strength(
        password,
        min_length=policy.password_min_length,
        require_uppercase=policy.require_uppercase,
        require_lowercase=policy.require_lowercase,
        require_digit=policy.require_digit,
        require_special=policy.require_special,
    )
    if errors:
        raise HTTPException(status_code=400, detail={"code": "WEAK_PASSWORD", "reasons": errors})


def _count_active_admins(db: Session) -> int:
    return int(
        db.execute(
            select(func.count(User.id)).where(User.role == UserRole.ADMIN, User.is_active.is_(True))
        ).scalar_one()
    )


def _nullify_user_refs(db: Session, user_id: UUID) -> dict[str, int]:
    updates = [
        ("users.created_by", User, User.created_by),
        ("categories.created_by", Category, Category.created_by),
        ("tags.created_by", Tag, Tag.created_by),
        ("rulesets.created_by", Ruleset, Ruleset.created_by),
        ("rule_versions.created_by", RuleVersion, RuleVersion.created_by),
        ("files.created_by", File, File.created_by),
        ("documents.created_by", Document, Document.created_by),
        ("document_versions.created_by", DocumentVersion, DocumentVersion.created_by),
        ("document_files.created_by", DocumentFile, DocumentFile.created_by),
        ("document_categories.created_by", DocumentCategory, DocumentCategory.created_by),
        ("document_tags.created_by", DocumentTag, DocumentTag.created_by),
        ("ingest_jobs.created_by", IngestJob, IngestJob.created_by),
        ("ingest_events.created_by", IngestEvent, IngestEvent.created_by),
        ("audit_logs.created_by", AuditLog, AuditLog.created_by),
        ("audit_logs.actor_user_id", AuditLog, AuditLog.actor_user_id),
        ("saved_filters.created_by", SavedFilter, SavedFilter.created_by),
        ("security_policies.created_by", SecurityPolicy, SecurityPolicy.created_by),
        ("branding_settings.created_by", BrandingSetting, BrandingSetting.created_by),
        ("backup_schedule_settings.created_by", BackupScheduleSetting, BackupScheduleSetting.created_by),
    ]

    result: dict[str, int] = {}
    for label, model, column in updates:
        stmt = update(model).where(column == user_id).values({column.key: None})
        affected = int(db.execute(stmt).rowcount or 0)
        if affected > 0:
            result[label] = affected
    return result


@router.post("/auth/login", response_model=LoginResponse)
def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)) -> LoginResponse:
    user = db.execute(select(User).where(User.username == req.username)).scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    policy = _get_auth_policy(db)
    now = _now()
    if user.locked_until and user.locked_until > now:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="account temporarily locked")

    if not verify_password(req.password, user.password_hash):
        user.failed_login_attempts = int(user.failed_login_attempts or 0) + 1
        locked_until: datetime | None = None
        if user.failed_login_attempts >= policy.max_failed_attempts:
            locked_until = now + timedelta(seconds=policy.lockout_seconds)
            user.locked_until = locked_until

        db.add(user)
        db.add(
            AuditLog(
                actor_user_id=None,
                action="AUTH_LOGIN_FAILED",
                target_type="user",
                target_id=user.id,
                after_json={
                    "username": user.username,
                    "failed_login_attempts": user.failed_login_attempts,
                    "locked_until": locked_until.isoformat() if locked_until else None,
                },
            )
        )
        db.commit()
        if locked_until:
            raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="account temporarily locked")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    user.failed_login_attempts = 0
    user.locked_until = None
    user.last_login_at = _now()
    db.add(user)
    db.add(
        AuditLog(
            actor_user_id=user.id,
            action="AUTH_LOGIN",
            target_type="user",
            target_id=user.id,
            after_json={"username": user.username, "role": user.role.value, "remember_me": bool(req.remember_me)},
        )
    )
    db.commit()

    session_ttl_seconds = (
        int(policy.auto_login_days) * 24 * 60 * 60 if req.remember_me else int(settings.session_max_age_seconds)
    )
    session_ttl_seconds = max(60, session_ttl_seconds)
    session_expires_at = now + timedelta(seconds=session_ttl_seconds)

    request.session["user_id"] = str(user.id)
    request.session["username"] = user.username
    request.session["role"] = user.role.value
    request.session["issued_at"] = now.isoformat()
    request.session["expires_at"] = session_expires_at.isoformat()
    request.session["remember_me"] = bool(req.remember_me)

    return LoginResponse(
        user=AuthUser(id=str(user.id), username=user.username, role=user.role),
        logged_in_at=user.last_login_at,
        session_expires_at=session_expires_at,
        remember_me=bool(req.remember_me),
    )


@router.post("/auth/logout", response_model=LogoutResponse)
def logout(
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LogoutResponse:
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="AUTH_LOGOUT",
            target_type="user",
            target_id=current_user.id,
            after_json={"username": current_user.username},
        )
    )
    db.commit()

    request.session.clear()
    return LogoutResponse(status="ok")


@router.get("/auth/me", response_model=AuthUser)
def me(current_user: CurrentUser = Depends(get_current_user)) -> AuthUser:
    return AuthUser(id=str(current_user.id), username=current_user.username, role=current_user.role)


@router.get(
    "/admin/security-policy",
    response_model=AuthSecurityPolicy,
    dependencies=[Depends(require_roles(UserRole.ADMIN))],
)
def get_security_policy(db: Session = Depends(get_db)) -> AuthSecurityPolicy:
    return _get_auth_policy(db)


@router.patch(
    "/admin/security-policy",
    response_model=AuthSecurityPolicy,
    dependencies=[Depends(require_roles(UserRole.ADMIN))],
)
def update_security_policy(
    req: UpdateAuthSecurityPolicyRequest,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AuthSecurityPolicy:
    before = _get_auth_policy(db).model_dump(mode="json")
    row = db.get(SecurityPolicy, "auth")
    if row is None:
        row = SecurityPolicy(
            scope="auth",
            password_min_length=settings.password_min_length,
            require_uppercase=True,
            require_lowercase=True,
            require_digit=True,
            require_special=True,
            max_failed_attempts=settings.auth_max_failed_attempts,
            lockout_seconds=settings.auth_lockout_seconds,
            auto_login_days=settings.auth_auto_login_days,
            created_by=current_user.id,
        )

    row.password_min_length = req.password_min_length
    row.require_uppercase = req.require_uppercase
    row.require_lowercase = req.require_lowercase
    row.require_digit = req.require_digit
    row.require_special = req.require_special
    row.max_failed_attempts = req.max_failed_attempts
    row.lockout_seconds = req.lockout_seconds
    row.auto_login_days = req.auto_login_days
    row.updated_at = _now()

    db.add(row)
    db.commit()
    db.refresh(row)

    after = _to_auth_policy_response(row).model_dump(mode="json")
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="AUTH_POLICY_UPDATE",
            target_type="security_policy",
            after_json=after,
            before_json=before,
        )
    )
    db.commit()

    return _to_auth_policy_response(row)


@router.get(
    "/admin/users",
    response_model=UsersListResponse,
    dependencies=[Depends(require_roles(UserRole.ADMIN))],
)
def list_users(
    q: str | None = Query(None),
    role: UserRole | None = Query(None),
    is_active: bool | None = Query(None),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> UsersListResponse:
    stmt = select(User)
    count_stmt = select(func.count(User.id))

    if q:
        expr = User.username.ilike(f"%{q.strip()}%")
        stmt = stmt.where(expr)
        count_stmt = count_stmt.where(expr)
    if role is not None:
        expr = User.role == role
        stmt = stmt.where(expr)
        count_stmt = count_stmt.where(expr)
    if is_active is not None:
        expr = User.is_active == is_active
        stmt = stmt.where(expr)
        count_stmt = count_stmt.where(expr)

    total = db.execute(count_stmt).scalar_one()
    rows = db.execute(
        stmt.order_by(User.created_at.asc()).offset((page - 1) * size).limit(size)
    ).scalars().all()

    return UsersListResponse(
        items=[
            UserSummary(
                id=str(u.id),
                username=u.username,
                role=u.role,
                is_active=u.is_active,
                failed_login_attempts=u.failed_login_attempts,
                locked_until=u.locked_until,
                created_at=u.created_at,
                last_login_at=u.last_login_at,
            )
            for u in rows
        ],
        page=page,
        size=size,
        total=total,
    )


@router.post(
    "/admin/users",
    response_model=UserSummary,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_roles(UserRole.ADMIN))],
)
def create_user(
    req: CreateUserRequest,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserSummary:
    existing = db.execute(select(User).where(User.username == req.username)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="username already exists")

    if req.password != req.password_confirm:
        raise HTTPException(status_code=400, detail="password confirmation does not match")

    _ensure_password_strength(req.password, db)

    user = User(
        username=req.username,
        password_hash=hash_password(req.password),
        role=req.role,
        is_active=True,
        failed_login_attempts=0,
        password_changed_at=_now(),
        created_by=current_user.id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="USER_CREATE",
            target_type="user",
            target_id=user.id,
            after_json={"username": user.username, "role": user.role.value},
        )
    )
    db.commit()

    return UserSummary(
        id=str(user.id),
        username=user.username,
        role=user.role,
        is_active=user.is_active,
        failed_login_attempts=user.failed_login_attempts,
        locked_until=user.locked_until,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
    )


@router.patch(
    "/admin/users/{user_id}",
    response_model=UserSummary,
    dependencies=[Depends(require_roles(UserRole.ADMIN))],
)
def update_user(
    user_id: UUID,
    req: UpdateUserRequest,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserSummary:
    user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="user not found")

    if req.password is None and req.password_confirm is not None:
        raise HTTPException(status_code=400, detail="password confirmation requires password")

    if req.role is None and req.is_active is None and req.password is None and not req.unlock_account:
        raise HTTPException(status_code=400, detail="nothing to update")

    if req.is_active is False and str(user.id) == str(current_user.id):
        raise HTTPException(status_code=400, detail="cannot deactivate current user")

    before = {
        "role": user.role.value,
        "is_active": user.is_active,
        "failed_login_attempts": user.failed_login_attempts,
        "locked_until": user.locked_until.isoformat() if user.locked_until else None,
    }
    masked_fields: list[str] = []

    if req.role is not None:
        user.role = req.role
    if req.is_active is not None:
        user.is_active = req.is_active
    if req.password is not None:
        if req.password_confirm is None:
            raise HTTPException(status_code=400, detail="password confirmation is required")
        if req.password != req.password_confirm:
            raise HTTPException(status_code=400, detail="password confirmation does not match")
        _ensure_password_strength(req.password, db)
        user.password_hash = hash_password(req.password)
        user.password_changed_at = _now()
        masked_fields.append("password")
    if req.unlock_account:
        user.failed_login_attempts = 0
        user.locked_until = None

    db.add(user)
    db.commit()
    db.refresh(user)

    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="USER_UPDATE",
            target_type="user",
            target_id=user.id,
            before_json=before,
            after_json={
                "role": user.role.value,
                "is_active": user.is_active,
                "password_updated": req.password is not None,
                "failed_login_attempts": user.failed_login_attempts,
                "locked_until": user.locked_until.isoformat() if user.locked_until else None,
                "unlock_account": bool(req.unlock_account),
            },
            masked_fields=masked_fields,
        )
    )
    db.commit()

    return UserSummary(
        id=str(user.id),
        username=user.username,
        role=user.role,
        is_active=user.is_active,
        failed_login_attempts=user.failed_login_attempts,
        locked_until=user.locked_until,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
    )


@router.post("/auth/change-password", response_model=ChangePasswordResponse)
def change_password(
    req: ChangePasswordRequest,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChangePasswordResponse:
    if req.new_password != req.confirm_new_password:
        raise HTTPException(status_code=400, detail="password confirmation does not match")

    user = db.get(User, current_user.id)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="invalid session")

    if not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="current password is invalid")

    if verify_password(req.new_password, user.password_hash):
        raise HTTPException(status_code=400, detail="new password must be different from current password")

    _ensure_password_strength(req.new_password, db)

    changed_at = _now()
    user.password_hash = hash_password(req.new_password)
    user.password_changed_at = changed_at
    user.failed_login_attempts = 0
    user.locked_until = None
    db.add(user)
    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="AUTH_CHANGE_PASSWORD",
            target_type="user",
            target_id=current_user.id,
            after_json={"username": current_user.username},
            masked_fields=["password"],
        )
    )
    db.commit()

    return ChangePasswordResponse(status="ok", changed_at=changed_at)


@router.delete(
    "/admin/users/{user_id}",
    response_model=DeleteUserResponse,
    dependencies=[Depends(require_roles(UserRole.ADMIN))],
)
def delete_user(
    user_id: UUID,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeleteUserResponse:
    user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="user not found")

    if str(user.id) == str(current_user.id):
        raise HTTPException(status_code=400, detail="cannot delete current user")

    if user.role == UserRole.ADMIN and user.is_active and _count_active_admins(db) <= 1:
        raise HTTPException(status_code=400, detail="cannot delete last active admin")

    before = {
        "username": user.username,
        "role": user.role.value,
        "is_active": user.is_active,
        "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
    }

    nullified_refs = _nullify_user_refs(db, user.id)

    try:
        db.delete(user)
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="cannot delete user due to relational constraints") from exc

    db.add(
        AuditLog(
            actor_user_id=current_user.id,
            action="USER_DELETE",
            target_type="user",
            target_id=user_id,
            before_json={**before, "nullified_refs": nullified_refs},
            after_json={"deleted": True},
        )
    )
    db.commit()

    return DeleteUserResponse(
        id=str(user_id),
        username=before["username"],
        deleted=True,
        nullified_refs=nullified_refs,
    )
