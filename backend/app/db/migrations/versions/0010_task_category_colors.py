"""add dashboard task category colors

Revision ID: 0010_task_colors
Revises: 0009_task_settings
Create Date: 2026-03-05 12:20:00

"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0010_task_colors"
down_revision = "0009_task_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("alter table dashboard_task_settings add column if not exists category_colors_json jsonb not null default '{}'::jsonb")
    op.execute(
        """
        update dashboard_task_settings
        set category_colors_json = jsonb_strip_nulls(
          coalesce(category_colors_json, '{}'::jsonb)
          || jsonb_build_object('할일', '#059669')
          || jsonb_build_object('회의', '#0284C7')
        )
        where scope = 'default'
        """
    )


def downgrade() -> None:
    op.execute("alter table dashboard_task_settings drop column if exists category_colors_json")
