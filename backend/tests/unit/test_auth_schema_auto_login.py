import pytest
from pydantic import ValidationError

from app.schemas.auth import LoginRequest, UpdateAuthSecurityPolicyRequest


def test_login_request_remember_me_defaults_to_false():
    req = LoginRequest(username="admin", password="x")
    assert req.remember_me is False


def test_login_request_remember_me_can_be_true():
    req = LoginRequest(username="admin", password="x", remember_me=True)
    assert req.remember_me is True


@pytest.mark.parametrize("value", [0, -1, 366, 999])
def test_security_policy_auto_login_days_out_of_range(value: int):
    with pytest.raises(ValidationError):
        UpdateAuthSecurityPolicyRequest(
            password_min_length=10,
            require_uppercase=True,
            require_lowercase=True,
            require_digit=True,
            require_special=True,
            max_failed_attempts=5,
            lockout_seconds=900,
            auto_login_days=value,
        )


def test_security_policy_auto_login_days_accepts_bounds():
    low = UpdateAuthSecurityPolicyRequest(
        password_min_length=10,
        require_uppercase=True,
        require_lowercase=True,
        require_digit=True,
        require_special=True,
        max_failed_attempts=5,
        lockout_seconds=900,
        auto_login_days=1,
    )
    high = UpdateAuthSecurityPolicyRequest(
        password_min_length=10,
        require_uppercase=True,
        require_lowercase=True,
        require_digit=True,
        require_special=True,
        max_failed_attempts=5,
        lockout_seconds=900,
        auto_login_days=365,
    )
    assert low.auto_login_days == 1
    assert high.auto_login_days == 365
