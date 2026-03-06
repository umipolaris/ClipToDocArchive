from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.db.models import User, UserRole
from app.db.session import get_db


@dataclass
class CurrentUser:
    id: UUID
    username: str
    role: UserRole


def _parse_session_expires_at(raw: object) -> datetime | None:
    if isinstance(raw, (int, float)):
        return datetime.fromtimestamp(float(raw), tz=timezone.utc)
    if isinstance(raw, str):
        txt = raw.strip()
        if not txt:
            return None
        try:
            dt = datetime.fromisoformat(txt.replace("Z", "+00:00"))
        except ValueError:
            try:
                return datetime.fromtimestamp(float(txt), tz=timezone.utc)
            except (TypeError, ValueError):
                return None
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    return None


def get_current_user(request: Request, db: Session = Depends(get_db)) -> CurrentUser:
    session = request.session
    user_id = session.get("user_id") if isinstance(session, dict) else None
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="auth required")

    expires_at_raw = session.get("expires_at") if isinstance(session, dict) else None
    if expires_at_raw is not None:
        expires_at = _parse_session_expires_at(expires_at_raw)
        if expires_at is None:
            request.session.clear()
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid session")
        if datetime.now(tz=timezone.utc) >= expires_at:
            request.session.clear()
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="session expired")

    try:
        user_uuid = UUID(str(user_id))
    except (TypeError, ValueError):
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid session")

    user = db.get(User, user_uuid)
    if not user or not user.is_active:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid session")

    return CurrentUser(id=user.id, username=user.username, role=user.role)


def require_roles(*allowed_roles: UserRole):
    def dependency(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if current_user.role not in allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
        return current_user

    return dependency
