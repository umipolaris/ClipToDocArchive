"""add document categories mapping table

Revision ID: 0012_document_categories
Revises: 0011_branding_logo
Create Date: 2026-03-06 09:00:00

"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0012_document_categories"
down_revision = "0011_branding_logo"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        create table if not exists document_categories (
          document_id uuid not null references documents(id) on delete cascade,
          category_id uuid not null references categories(id) on delete cascade,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by uuid references users(id),
          primary key (document_id, category_id)
        )
        """
    )
    op.execute(
        """
        create index if not exists idx_document_categories_category_document
        on document_categories (category_id, document_id)
        """
    )
    op.execute(
        """
        insert into document_categories (document_id, category_id, created_by)
        select id, category_id, created_by
        from documents
        where category_id is not null
        on conflict (document_id, category_id) do nothing
        """
    )


def downgrade() -> None:
    op.execute("drop index if exists idx_document_categories_category_document")
    op.execute("drop table if exists document_categories")

