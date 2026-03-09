"""add dashboard task document/file link

Revision ID: 0016_task_document_file_link
Revises: 0015_task_holidays
Create Date: 2026-03-09 22:40:00

"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0016_task_document_file_link"
down_revision = "0015_task_holidays"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        alter table dashboard_tasks
        add column if not exists linked_document_id uuid
        """
    )
    op.execute(
        """
        alter table dashboard_tasks
        add column if not exists linked_file_id uuid
        """
    )
    op.execute(
        """
        do $$
        begin
          if not exists (
            select 1
            from pg_constraint
            where conname = 'fk_dashboard_tasks_linked_document_id'
          ) then
            alter table dashboard_tasks
            add constraint fk_dashboard_tasks_linked_document_id
            foreign key (linked_document_id)
            references documents (id)
            on delete set null;
          end if;
        end
        $$;
        """
    )
    op.execute(
        """
        do $$
        begin
          if not exists (
            select 1
            from pg_constraint
            where conname = 'fk_dashboard_tasks_linked_file_id'
          ) then
            alter table dashboard_tasks
            add constraint fk_dashboard_tasks_linked_file_id
            foreign key (linked_file_id)
            references files (id)
            on delete set null;
          end if;
        end
        $$;
        """
    )
    op.execute(
        """
        create index if not exists idx_dashboard_tasks_linked_document_id
        on dashboard_tasks (linked_document_id)
        """
    )
    op.execute(
        """
        create index if not exists idx_dashboard_tasks_linked_file_id
        on dashboard_tasks (linked_file_id)
        """
    )


def downgrade() -> None:
    op.execute("drop index if exists idx_dashboard_tasks_linked_file_id")
    op.execute("drop index if exists idx_dashboard_tasks_linked_document_id")
    op.execute("alter table dashboard_tasks drop constraint if exists fk_dashboard_tasks_linked_file_id")
    op.execute("alter table dashboard_tasks drop constraint if exists fk_dashboard_tasks_linked_document_id")
    op.execute("alter table dashboard_tasks drop column if exists linked_file_id")
    op.execute("alter table dashboard_tasks drop column if exists linked_document_id")
