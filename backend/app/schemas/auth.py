from datetime import datetime

from pydantic import BaseModel, Field

from app.db.models import UserRole


class LoginRequest(BaseModel):
    username: str
    password: str
    remember_me: bool = False


class AuthUser(BaseModel):
    id: str
    username: str
    role: UserRole


class LoginResponse(BaseModel):
    user: AuthUser
    logged_in_at: datetime
    session_expires_at: datetime
    remember_me: bool = False


class LogoutResponse(BaseModel):
    status: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    password_confirm: str
    role: UserRole = UserRole.VIEWER


class UserSummary(BaseModel):
    id: str
    username: str
    role: UserRole
    is_active: bool
    failed_login_attempts: int = 0
    locked_until: datetime | None = None
    created_at: datetime
    last_login_at: datetime | None = None


class UsersListResponse(BaseModel):
    items: list[UserSummary]
    page: int = 1
    size: int = 50
    total: int = 0


class UpdateUserRequest(BaseModel):
    role: UserRole | None = None
    is_active: bool | None = None
    password: str | None = None
    password_confirm: str | None = None
    unlock_account: bool | None = None


class DeleteUserResponse(BaseModel):
    id: str
    username: str
    deleted: bool = True
    nullified_refs: dict[str, int] = Field(default_factory=dict)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str
    confirm_new_password: str


class ChangePasswordResponse(BaseModel):
    status: str = "ok"
    changed_at: datetime


class AuthSecurityPolicy(BaseModel):
    scope: str = "auth"
    password_min_length: int = 10
    require_uppercase: bool = True
    require_lowercase: bool = True
    require_digit: bool = True
    require_special: bool = True
    max_failed_attempts: int = 5
    lockout_seconds: int = 900
    auto_login_days: int = 7
    updated_at: datetime | None = None


class UpdateAuthSecurityPolicyRequest(BaseModel):
    password_min_length: int = Field(ge=6, le=128)
    require_uppercase: bool = True
    require_lowercase: bool = True
    require_digit: bool = True
    require_special: bool = True
    max_failed_attempts: int = Field(ge=1, le=20)
    lockout_seconds: int = Field(ge=60, le=86_400)
    auto_login_days: int = Field(ge=1, le=365)
