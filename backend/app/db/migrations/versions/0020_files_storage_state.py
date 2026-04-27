"""add storage_state column to files for async minio uploads

Revision ID: 0020_files_storage_state
Revises: 0019_dashboard_milestones
Create Date: 2026-04-24 02:30:00

"""

from alembic import op


revision = "0020_files_storage_state"
down_revision = "0019_dashboard_milestones"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        alter table files
        add column if not exists storage_state varchar(16) not null default 'stored'
        """
    )
    op.execute(
        """
        create index if not exists idx_files_storage_state_pending
        on files (storage_state)
        where storage_state <> 'stored'
        """
    )


def downgrade() -> None:
    op.execute("drop index if exists idx_files_storage_state_pending")
    op.execute("alter table files drop column if exists storage_state")
