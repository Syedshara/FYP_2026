"""Add 'watcher-link' value to workspace_edge_type_enum.

Revision ID: j4k5l6m7n8o9
Revises: i3j4k5l6m7n8
Create Date: 2026-03-31

PostgreSQL enums cannot drop values without recreating the type, so the
downgrade is intentionally left as a no-op.
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "j4k5l6m7n8o9"
down_revision = "i3j4k5l6m7n8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TYPE workspace_edge_type_enum ADD VALUE IF NOT EXISTS 'watcher-link'"
    )


def downgrade() -> None:
    # PostgreSQL does not support removing enum values without dropping and
    # recreating the type plus all columns that depend on it.
    pass
