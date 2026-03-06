"""add backup schedule settings table

Revision ID: 0013_backup_schedule_settings
Revises: 0012_document_categories
Create Date: 2026-03-06 10:35:00

"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0013_backup_schedule_settings"
down_revision = "0012_document_categories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        create table if not exists backup_schedule_settings (
          scope varchar(32) primary key,
          enabled boolean not null default false,
          interval_days integer not null default 1,
          run_time varchar(5) not null default '02:00',
          target_dir varchar(255) not null default 'scheduled',
          last_run_at timestamptz,
          last_status varchar(16),
          last_error text,
          last_output_dir text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by uuid references users(id)
        )
        """
    )
    op.execute(
        """
        create index if not exists idx_backup_schedule_settings_enabled
        on backup_schedule_settings (enabled, updated_at desc)
        """
    )
    op.execute(
        """
        insert into backup_schedule_settings (scope, enabled, interval_days, run_time, target_dir, created_by)
        values ('default', false, 1, '02:00', 'scheduled', null)
        on conflict (scope) do nothing
        """
    )


def downgrade() -> None:
    op.execute("drop index if exists idx_backup_schedule_settings_enabled")
    op.execute("drop table if exists backup_schedule_settings")
