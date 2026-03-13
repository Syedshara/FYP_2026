"""fl_client canvas binding: add canvas_node_id and data_source columns

Revision ID: f1a2b3c4d5e6
Revises: e5f6a7b8c9d0
Create Date: 2026-03-13

"""
from typing import Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, None] = 'e5f6a7b8c9d0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'fl_clients',
        sa.Column('canvas_node_id', sa.String(100), nullable=True, unique=True),
    )
    op.create_index(
        'ix_fl_clients_canvas_node_id',
        'fl_clients',
        ['canvas_node_id'],
        unique=True,
    )
    op.add_column(
        'fl_clients',
        sa.Column('data_source', sa.String(20), nullable=False, server_default='cic-ids2017'),
    )


def downgrade() -> None:
    op.drop_index('ix_fl_clients_canvas_node_id', table_name='fl_clients')
    op.drop_column('fl_clients', 'canvas_node_id')
    op.drop_column('fl_clients', 'data_source')
