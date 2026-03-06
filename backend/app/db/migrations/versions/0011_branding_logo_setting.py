"""add branding logo settings table

Revision ID: 0011_branding_logo
Revises: 0010_task_colors
Create Date: 2026-03-05 17:15:00

"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0011_branding_logo"
down_revision = "0010_task_colors"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        create table if not exists branding_settings (
          scope varchar(32) primary key,
          logo_file_id uuid references files(id) on delete set null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by uuid references users(id)
        )
        """
    )
    op.execute(
        """
        insert into branding_settings (scope, logo_file_id, created_by)
        values ('default', null, null)
        on conflict (scope) do nothing
        """
    )


def downgrade() -> None:
    op.execute("drop table if exists branding_settings")

