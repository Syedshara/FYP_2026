"""Add 'watcher' value to workspace_node_type_enum.

Revision ID: i3j4k5l6m7n8
Revises: h2i3j4k5l6m7
Create Date: 2026-03-31

PostgreSQL enums cannot drop values without recreating the type, so the
downgrade is intentionally left as a no-op.  To fully revert, recreate the
enum manually and update all dependents.
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "i3j4k5l6m7n8"
down_revision = "h2i3j4k5l6m7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE workspace_node_type_enum ADD VALUE IF NOT EXISTS 'watcher'")


def downgrade() -> None:
    # PostgreSQL does not support removing enum values without dropping and
    # recreating the type plus all columns that depend on it.  This downgrade
    # is intentionally a no-op; revert manually if required.
    pass
