"""add dashboard milestones

Revision ID: 0019_dashboard_milestones
Revises: 0018_document_file_display_name
Create Date: 2026-03-20 10:20:00

"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0019_dashboard_milestones"
down_revision = "0018_document_file_display_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        create table if not exists dashboard_milestones (
            id uuid primary key,
            title varchar(180) not null,
            start_date date not null,
            end_date date,
            description text not null default '',
            color varchar(7),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            created_by uuid references users(id)
        )
        """
    )
    op.execute(
        """
        create index if not exists idx_dashboard_milestones_start_date
        on dashboard_milestones (start_date asc)
        """
    )


def downgrade() -> None:
    op.execute("drop index if exists idx_dashboard_milestones_start_date")
    op.execute("drop table if exists dashboard_milestones")
