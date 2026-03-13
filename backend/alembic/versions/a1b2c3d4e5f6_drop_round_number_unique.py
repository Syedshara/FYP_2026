"""Drop unique constraint on fl_rounds.round_number

Round numbers repeat across training sessions, so the column
should not have a unique constraint.

Revision ID: a1b2c3d4e5f6
Revises: f1a2b3c4d5e6
Create Date: 2026-03-13
"""
from alembic import op

revision = "a1b2c3d4e5f6"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("fl_rounds_round_number_key", "fl_rounds", type_="unique")
    op.create_index("ix_fl_rounds_round_number", "fl_rounds", ["round_number"])


def downgrade() -> None:
    op.drop_index("ix_fl_rounds_round_number", table_name="fl_rounds")
    op.create_unique_constraint("fl_rounds_round_number_key", "fl_rounds", ["round_number"])
