"""Add trust_score column to fl_clients table.

Revision ID: g1h2i3j4k5l6
Revises: f1a2b3c4d5e6
Create Date: 2026-03-15

Persists per-client trust scores across backend restarts so that RECESS
detection history is not lost when the container is restarted.
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "g1h2i3j4k5l6"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "fl_clients",
        sa.Column(
            "trust_score",
            sa.Float(),
            nullable=False,
            server_default="1.0",
        ),
    )


def downgrade() -> None:
    op.drop_column("fl_clients", "trust_score")
