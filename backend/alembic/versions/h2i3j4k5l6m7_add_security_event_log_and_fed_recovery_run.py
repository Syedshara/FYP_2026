"""Add security_event_log and fed_recovery_runs tables.

Revision ID: h2i3j4k5l6m7
Revises: g1h2i3j4k5l6
Create Date: 2026-03-30

Adds two tables required for Phase 3 (RECESS visualisation + FedRecovery):
  - security_event_log  : durable audit trail of all security pipeline events
  - fed_recovery_runs   : crash-safe record of each FedRecovery correction run
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "h2i3j4k5l6m7"
down_revision = "g1h2i3j4k5l6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── security_event_log ───────────────────────────────
    op.create_table(
        "security_event_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind", sa.String(length=80), nullable=False),
        sa.Column("round", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.String(length=50), nullable=True),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("data", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_security_event_log_kind", "security_event_log", ["kind"])
    op.create_index("ix_security_event_log_round", "security_event_log", ["round"])
    op.create_index(
        "ix_security_event_log_client_id", "security_event_log", ["client_id"]
    )
    op.create_index(
        "ix_security_event_log_created_at", "security_event_log", ["created_at"]
    )

    # ── fed_recovery_runs ────────────────────────────────
    op.create_table(
        "fed_recovery_runs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("flagged_client_id", sa.String(length=50), nullable=False),
        sa.Column("flag_round", sa.Integer(), nullable=False),
        sa.Column("rounds_corrected", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rounds_skipped", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "status",
            sa.Enum(
                "running",
                "complete",
                "partial",
                "failed",
                "cancelled",
                name="fed_recovery_status_enum",
                create_constraint=True,
            ),
            nullable=False,
            server_default="running",
        ),
        sa.Column("steps", sa.JSON(), nullable=True),
        sa.Column("before_norms", sa.JSON(), nullable=True),
        sa.Column("after_norms", sa.JSON(), nullable=True),
        sa.Column("epsilon", sa.Float(), nullable=True),
        sa.Column("sigma", sa.Float(), nullable=True),
        sa.Column("accuracy_before", sa.Float(), nullable=True),
        sa.Column("accuracy_after", sa.Float(), nullable=True),
        sa.Column("loss_before", sa.Float(), nullable=True),
        sa.Column("loss_after", sa.Float(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id"),
    )
    op.create_index("ix_fed_recovery_runs_run_id", "fed_recovery_runs", ["run_id"])
    op.create_index(
        "ix_fed_recovery_runs_flagged_client_id",
        "fed_recovery_runs",
        ["flagged_client_id"],
    )
    op.create_index("ix_fed_recovery_runs_status", "fed_recovery_runs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_fed_recovery_runs_status", table_name="fed_recovery_runs")
    op.drop_index(
        "ix_fed_recovery_runs_flagged_client_id", table_name="fed_recovery_runs"
    )
    op.drop_index("ix_fed_recovery_runs_run_id", table_name="fed_recovery_runs")
    op.drop_table("fed_recovery_runs")
    op.execute("DROP TYPE IF EXISTS fed_recovery_status_enum")

    op.drop_index("ix_security_event_log_created_at", table_name="security_event_log")
    op.drop_index("ix_security_event_log_client_id", table_name="security_event_log")
    op.drop_index("ix_security_event_log_round", table_name="security_event_log")
    op.drop_index("ix_security_event_log_kind", table_name="security_event_log")
    op.drop_table("security_event_log")
