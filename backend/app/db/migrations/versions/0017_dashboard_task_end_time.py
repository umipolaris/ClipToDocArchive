"""add dashboard task end time

Revision ID: 0017_task_end_time
Revises: 0016_task_document_file_link
Create Date: 2026-03-11 10:40:00

"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0017_task_end_time"
down_revision = "0016_task_document_file_link"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        alter table dashboard_tasks
        add column if not exists ended_at timestamptz
        """
    )


def downgrade() -> None:
    op.execute("alter table dashboard_tasks drop column if exists ended_at")
