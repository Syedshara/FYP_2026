"""Add security_data and trust_scores JSON columns to fl_rounds

Stores per-round security event snapshots and trust score snapshots
for post-hoc analysis and the FLOutputPanel timeline.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-03-14
"""
from alembic import op
import sqlalchemy as sa

revision = "b2c3d4e5f6a7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("fl_rounds", sa.Column("security_data", sa.JSON(), nullable=True))
    op.add_column("fl_rounds", sa.Column("trust_scores", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("fl_rounds", "trust_scores")
    op.drop_column("fl_rounds", "security_data")
