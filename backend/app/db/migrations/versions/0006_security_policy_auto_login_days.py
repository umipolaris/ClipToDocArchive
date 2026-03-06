"""add auto login days to security policy

Revision ID: 0006_auto_login_days
Revises: 0005_document_comments
Create Date: 2026-03-04 18:40:00

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = "0006_auto_login_days"
down_revision = "0005_document_comments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        alter table security_policies
        add column if not exists auto_login_days int not null default 30
        """
    )
    op.execute(
        """
        update security_policies
        set auto_login_days = 30
        where auto_login_days is null
        """
    )


def downgrade() -> None:
    op.execute(
        """
        alter table security_policies
        drop column if exists auto_login_days
        """
    )
