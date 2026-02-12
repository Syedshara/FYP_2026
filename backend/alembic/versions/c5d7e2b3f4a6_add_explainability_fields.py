"""add explainability fields to predictions

Revision ID: c5d7e2b3f4a6
Revises: b3f8a2c1d4e5
Create Date: 2026-02-11 12:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c5d7e2b3f4a6'
down_revision: Union[str, None] = 'b3f8a2c1d4e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── predictions: add explainability fields ───────────────
    op.add_column('predictions', sa.Column('top_anomalies', sa.JSON(), nullable=True))
    op.add_column('predictions', sa.Column('temporal_pattern', sa.String(length=100), nullable=True))


def downgrade() -> None:
    # ── predictions: remove explainability fields ────────────
    op.drop_column('predictions', 'temporal_pattern')
    op.drop_column('predictions', 'top_anomalies')
