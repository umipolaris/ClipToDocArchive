"""add dashboard task settings and category

Revision ID: 0009_task_settings
Revises: 0008_dashboard_tasks
Create Date: 2026-03-05 11:40:00

"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0009_task_settings"
down_revision = "0008_dashboard_tasks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("alter table alembic_version alter column version_num type varchar(255)")
    op.execute("alter table dashboard_tasks add column if not exists category varchar(80)")
    op.execute(
        """
        update dashboard_tasks
        set category = case
          when kind = 'MEETING' then '회의'
          else '할일'
        end
        where category is null or btrim(category) = ''
        """
    )
    op.execute("alter table dashboard_tasks alter column category set not null")
    op.execute(
        """
        create index if not exists idx_dashboard_tasks_category_scheduled_at
        on dashboard_tasks (category, scheduled_at asc)
        """
    )
    op.execute(
        """
        create table if not exists dashboard_task_settings (
          scope varchar(32) primary key,
          categories_json jsonb not null default '[]'::jsonb,
          allow_all_day boolean not null default true,
          use_location boolean not null default true,
          use_comment boolean not null default true,
          default_time varchar(5) not null default '09:00',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by uuid references users(id)
        )
        """
    )
    op.execute(
        """
        insert into dashboard_task_settings (
          scope, categories_json, allow_all_day, use_location, use_comment, default_time
        )
        values (
          'default',
          '["할일","회의"]'::jsonb,
          true,
          true,
          true,
          '09:00'
        )
        on conflict (scope) do nothing
        """
    )


def downgrade() -> None:
    op.execute("drop table if exists dashboard_task_settings")
    op.execute("drop index if exists idx_dashboard_tasks_category_scheduled_at")
    op.execute("alter table dashboard_tasks drop column if exists category")
