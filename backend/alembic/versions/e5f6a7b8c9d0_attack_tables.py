"""attack_tables

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-03-12 00:00:01.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Enum types (idempotent) ──────────────────────────────────────────
    op.execute(sa.text(
        "DO $$ BEGIN "
        "CREATE TYPE attack_category_enum AS ENUM "
        "('ddos','mitm','port-scan','replay','malformed','botnet','iot-protocol'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    ))
    op.execute(sa.text(
        "DO $$ BEGIN "
        "CREATE TYPE attack_run_status_enum AS ENUM "
        "('pending','starting','running','stopping','completed','failed','cancelled'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    ))

    # ── attacks table ────────────────────────────────────────────────────
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS attacks (
            id             SERIAL PRIMARY KEY,
            name           VARCHAR(120)     NOT NULL,
            description    TEXT,
            category       attack_category_enum NOT NULL,
            sub_type       VARCHAR(80)      NOT NULL,
            target_ip      VARCHAR(45),
            target_port    INTEGER,
            params         JSONB            NOT NULL DEFAULT '{}',
            user_id        UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
            updated_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
        );
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_attacks_user_id ON attacks (user_id);"
    ))

    # ── attack_runs table ────────────────────────────────────────────────
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS attack_runs (
            id                SERIAL PRIMARY KEY,
            attack_id         INTEGER          NOT NULL REFERENCES attacks(id) ON DELETE CASCADE,
            status            attack_run_status_enum NOT NULL DEFAULT 'pending',
            container_id      VARCHAR(80),
            container_name    VARCHAR(120),
            duration_seconds  DOUBLE PRECISION,
            packets_sent      INTEGER,
            packets_captured  INTEGER,
            detections        INTEGER,
            detection_rate    DOUBLE PRECISION,
            results           JSONB            NOT NULL DEFAULT '{}',
            error_message     TEXT,
            started_at        TIMESTAMPTZ      NOT NULL DEFAULT now(),
            finished_at       TIMESTAMPTZ
        );
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_attack_runs_attack_id ON attack_runs (attack_id);"
    ))


def downgrade() -> None:
    op.drop_index('ix_attack_runs_attack_id', table_name='attack_runs')
    op.drop_table('attack_runs')
    op.drop_index('ix_attacks_user_id', table_name='attacks')
    op.drop_table('attacks')
    sa.Enum(name='attack_run_status_enum').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='attack_category_enum').drop(op.get_bind(), checkfirst=True)
