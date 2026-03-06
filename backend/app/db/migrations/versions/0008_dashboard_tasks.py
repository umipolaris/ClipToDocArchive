"""add dashboard tasks

Revision ID: 0008_dashboard_tasks
Revises: 0007_auto_login_default_7
Create Date: 2026-03-04 20:05:00

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = "0008_dashboard_tasks"
down_revision = "0007_auto_login_default_7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("create type dashboard_task_kind as enum ('TODO','MEETING')")
    op.execute(
        """
        create table dashboard_tasks (
          id uuid primary key default gen_random_uuid(),
          kind dashboard_task_kind not null,
          title varchar(220) not null,
          scheduled_at timestamptz not null,
          all_day boolean not null default false,
          location varchar(220),
          comment varchar(300),
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by uuid references users(id)
        )
        """
    )
    op.execute(
        """
        create index idx_dashboard_tasks_scheduled_at
        on dashboard_tasks (scheduled_at asc)
        """
    )
    op.execute(
        """
        create index idx_dashboard_tasks_kind_scheduled_at
        on dashboard_tasks (kind, scheduled_at asc)
        """
    )


def downgrade() -> None:
    op.execute("drop index if exists idx_dashboard_tasks_kind_scheduled_at")
    op.execute("drop index if exists idx_dashboard_tasks_scheduled_at")
    op.execute("drop table if exists dashboard_tasks")
    op.execute("drop type if exists dashboard_task_kind")
