"""set security policy auto login default to 7 days

Revision ID: 0007_auto_login_default_7
Revises: 0006_auto_login_days
Create Date: 2026-03-04 19:05:00

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = "0007_auto_login_default_7"
down_revision = "0006_auto_login_days"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        alter table security_policies
        alter column auto_login_days set default 7
        """
    )
    op.execute(
        """
        update security_policies
        set auto_login_days = 7
        where auto_login_days is null or auto_login_days = 30
        """
    )


def downgrade() -> None:
    op.execute(
        """
        alter table security_policies
        alter column auto_login_days set default 30
        """
    )
