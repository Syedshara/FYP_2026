"""pipeline_tables

Revision ID: c1d2e3f4a5b6
Revises: b3f8a2c1d4e5
Create Date: 2026-03-11 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c1d2e3f4a5b6'
down_revision: Union[str, None] = 'b3f8a2c1d4e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Enum types (idempotent — survives partial prior runs) ─────────────
    op.execute(sa.text(
        "DO $$ BEGIN "
        "CREATE TYPE pipeline_status_enum AS ENUM ('idle','running','error'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    ))
    op.execute(sa.text(
        "DO $$ BEGIN "
        "CREATE TYPE pipeline_node_type_enum AS ENUM "
        "('source_scenario','attack_inject','rate_filter','monitor_sink'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    ))

    # ── pipelines table ───────────────────────────────────────────────────
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS pipelines (
            id          SERIAL PRIMARY KEY,
            name        VARCHAR(100)    NOT NULL DEFAULT 'New Pipeline',
            description TEXT,
            status      pipeline_status_enum NOT NULL DEFAULT 'idle',
            created_at  TIMESTAMPTZ     NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
        );
    """))

    # ── pipeline_nodes table ──────────────────────────────────────────────
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS pipeline_nodes (
            id          SERIAL PRIMARY KEY,
            pipeline_id INTEGER         NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
            node_key    VARCHAR(50)     NOT NULL,
            node_type   pipeline_node_type_enum NOT NULL,
            label       VARCHAR(100)    NOT NULL DEFAULT '',
            config      JSONB           NOT NULL DEFAULT '{}',
            position_x  DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            position_y  DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            edges_json  JSONB           NOT NULL DEFAULT '[]',
            created_at  TIMESTAMPTZ     NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
        );
    """))

    # ── Index ─────────────────────────────────────────────────────────────
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_pipeline_nodes_pipeline_id "
        "ON pipeline_nodes (pipeline_id);"
    ))


def downgrade() -> None:
    op.drop_index('ix_pipeline_nodes_pipeline_id', table_name='pipeline_nodes')
    op.drop_table('pipeline_nodes')
    op.drop_table('pipelines')
    sa.Enum(name='pipeline_node_type_enum').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='pipeline_status_enum').drop(op.get_bind(), checkfirst=True)
