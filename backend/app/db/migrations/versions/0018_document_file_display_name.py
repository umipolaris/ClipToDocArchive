"""add document file display filename

Revision ID: 0018_document_file_display_name
Revises: 0017_task_end_time
Create Date: 2026-03-19 17:40:00

"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0018_document_file_display_name"
down_revision = "0017_task_end_time"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        alter table document_files
        add column if not exists display_filename text
        """
    )
    op.execute(
        """
        update document_files df
        set display_filename = f.original_filename
        from files f
        where df.file_id = f.id
          and (df.display_filename is null or btrim(df.display_filename) = '')
        """
    )


def downgrade() -> None:
    op.execute("alter table document_files drop column if exists display_filename")
