"""workspace_tables

Revision ID: d4e5f6a7b8c9
Revises: c1d2e3f4a5b6
Create Date: 2026-03-11 00:00:01.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, None] = 'c1d2e3f4a5b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Enum types (idempotent) ──────────────────────────────────────────
    op.execute(sa.text(
        "DO $$ BEGIN "
        "CREATE TYPE workspace_node_type_enum AS ENUM "
        "('client','device','fl-server','attack','traffic-source','rate-filter','monitor'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    ))
    op.execute(sa.text(
        "DO $$ BEGIN "
        "CREATE TYPE workspace_edge_type_enum AS ENUM "
        "('ownership','fl-communication','traffic-feed','attack-vector','observation'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    ))

    # ── workspaces table ─────────────────────────────────────────────────
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS workspaces (
            id             SERIAL PRIMARY KEY,
            name           VARCHAR(100)     NOT NULL DEFAULT 'My Workspace',
            description    TEXT,
            user_id        UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            viewport_x     DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            viewport_y     DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            viewport_zoom  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
            created_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
            updated_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
        );
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_workspaces_user_id ON workspaces (user_id);"
    ))

    # ── workspace_nodes table ────────────────────────────────────────────
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS workspace_nodes (
            id             SERIAL PRIMARY KEY,
            workspace_id   INTEGER          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            node_key       VARCHAR(80)      NOT NULL,
            node_type      workspace_node_type_enum NOT NULL,
            position_x     DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            position_y     DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            data           JSONB            NOT NULL DEFAULT '{}',
            created_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
            updated_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
        );
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_workspace_nodes_workspace_id "
        "ON workspace_nodes (workspace_id);"
    ))

    # ── workspace_edges table ────────────────────────────────────────────
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS workspace_edges (
            id             SERIAL PRIMARY KEY,
            workspace_id   INTEGER          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            edge_key       VARCHAR(80)      NOT NULL,
            edge_type      workspace_edge_type_enum NOT NULL,
            source_key     VARCHAR(80)      NOT NULL,
            target_key     VARCHAR(80)      NOT NULL,
            data           JSONB            NOT NULL DEFAULT '{}',
            created_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
        );
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_workspace_edges_workspace_id "
        "ON workspace_edges (workspace_id);"
    ))


def downgrade() -> None:
    op.drop_index('ix_workspace_edges_workspace_id', table_name='workspace_edges')
    op.drop_table('workspace_edges')
    op.drop_index('ix_workspace_nodes_workspace_id', table_name='workspace_nodes')
    op.drop_table('workspace_nodes')
    op.drop_index('ix_workspaces_user_id', table_name='workspaces')
    op.drop_table('workspaces')
    sa.Enum(name='workspace_edge_type_enum').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='workspace_node_type_enum').drop(op.get_bind(), checkfirst=True)
