"""phase2 client device relations

Revision ID: b3f8a2c1d4e5
Revises: 422eeb5b1f9f
Create Date: 2026-02-10 10:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3f8a2c1d4e5'
down_revision: Union[str, None] = '422eeb5b1f9f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── fl_clients: add new columns ──────────────────────────
    op.add_column('fl_clients', sa.Column('name', sa.String(length=100), nullable=False, server_default=''))
    op.add_column('fl_clients', sa.Column('description', sa.Text(), nullable=True))
    op.add_column('fl_clients', sa.Column('ip_address', sa.String(length=45), nullable=True))
    op.add_column('fl_clients', sa.Column('container_name', sa.String(length=100), nullable=True))
    op.add_column('fl_clients', sa.Column('total_samples', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('fl_clients', sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True))

    # Add 'error' to the fl_client_status_enum
    # PostgreSQL: alter the enum type to add the new value
    op.execute("ALTER TYPE fl_client_status_enum ADD VALUE IF NOT EXISTS 'error'")

    # ── devices: add client_id FK ────────────────────────────
    op.add_column('devices', sa.Column('client_id', sa.Integer(), nullable=True))
    op.create_index(op.f('ix_devices_client_id'), 'devices', ['client_id'], unique=False)
    op.create_foreign_key(
        'fk_devices_client_id',
        'devices', 'fl_clients',
        ['client_id'], ['id'],
        ondelete='SET NULL',
    )

    # ── predictions: add client_id FK + device_id FK constraint ──
    op.add_column('predictions', sa.Column('client_id', sa.Integer(), nullable=True))
    op.create_index(op.f('ix_predictions_client_id'), 'predictions', ['client_id'], unique=False)
    op.create_foreign_key(
        'fk_predictions_client_id',
        'predictions', 'fl_clients',
        ['client_id'], ['id'],
        ondelete='SET NULL',
    )

    # Clean up orphaned predictions before adding FK constraint on device_id
    op.execute(
        "DELETE FROM predictions WHERE device_id NOT IN (SELECT id FROM devices)"
    )
    op.create_foreign_key(
        'fk_predictions_device_id',
        'predictions', 'devices',
        ['device_id'], ['id'],
        ondelete='CASCADE',
    )

    # ── fl_client_metrics: add round_id FK constraint ────────
    op.create_foreign_key(
        'fk_fl_client_metrics_round_id',
        'fl_client_metrics', 'fl_rounds',
        ['round_id'], ['id'],
        ondelete='CASCADE',
    )


def downgrade() -> None:
    # ── fl_client_metrics: drop round_id FK ──────────────────
    op.drop_constraint('fk_fl_client_metrics_round_id', 'fl_client_metrics', type_='foreignkey')

    # ── predictions: drop client_id FK + column ──────────────
    op.drop_constraint('fk_predictions_device_id', 'predictions', type_='foreignkey')
    op.drop_constraint('fk_predictions_client_id', 'predictions', type_='foreignkey')
    op.drop_index(op.f('ix_predictions_client_id'), table_name='predictions')
    op.drop_column('predictions', 'client_id')

    # ── devices: drop client_id FK + column ──────────────────
    op.drop_constraint('fk_devices_client_id', 'devices', type_='foreignkey')
    op.drop_index(op.f('ix_devices_client_id'), table_name='devices')
    op.drop_column('devices', 'client_id')

    # ── fl_clients: drop new columns ─────────────────────────
    op.drop_column('fl_clients', 'updated_at')
    op.drop_column('fl_clients', 'total_samples')
    op.drop_column('fl_clients', 'container_name')
    op.drop_column('fl_clients', 'ip_address')
    op.drop_column('fl_clients', 'description')
    op.drop_column('fl_clients', 'name')

    # Note: Cannot remove 'error' from enum in downgrade easily
    # PostgreSQL doesn't support DROP VALUE from enum
