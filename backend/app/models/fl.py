"""
FL round + client metrics models.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import (
    Integer,
    Float,
    String,
    Boolean,
    DateTime,
    Text,
    JSON,
    Enum as SAEnum,
    ForeignKey,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.device import Device


class FLRound(Base):
    __tablename__ = "fl_rounds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    round_number: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    num_clients: Mapped[int] = mapped_column(Integer, nullable=False)
    global_loss: Mapped[float | None] = mapped_column(Float, nullable=True)
    global_accuracy: Mapped[float | None] = mapped_column(Float, nullable=True)
    global_f1: Mapped[float | None] = mapped_column(Float, nullable=True)
    global_precision: Mapped[float | None] = mapped_column(Float, nullable=True)
    global_recall: Mapped[float | None] = mapped_column(Float, nullable=True)
    aggregation_method: Mapped[str] = mapped_column(
        String(50), nullable=False, default="fedavg_he"
    )
    he_scheme: Mapped[str | None] = mapped_column(String(20), nullable=True)
    he_poly_modulus: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    model_checkpoint_path: Mapped[str | None] = mapped_column(
        String(500), nullable=True
    )
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    # JSON snapshots persisted per round (nullable — populated when security pipeline is active)
    security_data: Mapped[dict | None] = mapped_column(
        JSON, nullable=True, default=None
    )
    trust_scores: Mapped[dict | None] = mapped_column(JSON, nullable=True, default=None)

    # Relationships
    client_metrics: Mapped[list["FLClientMetric"]] = relationship(
        back_populates="round", cascade="all, delete-orphan"
    )


class FLClientMetric(Base):
    __tablename__ = "fl_client_metrics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    round_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("fl_rounds.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    client_id: Mapped[str] = mapped_column(String(50), nullable=False)
    local_loss: Mapped[float] = mapped_column(Float, nullable=False)
    local_accuracy: Mapped[float] = mapped_column(Float, nullable=False)
    num_samples: Mapped[int] = mapped_column(Integer, nullable=False)
    training_time_sec: Mapped[float] = mapped_column(Float, nullable=False)
    encrypted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Relationships
    round: Mapped["FLRound"] = relationship(back_populates="client_metrics")


class FLClient(Base):
    """
    Registered FL clients — each represents a federated learning participant.
    One client can own many devices.
    """

    __tablename__ = "fl_clients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(
        String(50), unique=True, nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    status: Mapped[str] = mapped_column(
        SAEnum(
            "active",
            "inactive",
            "training",
            "error",
            name="fl_client_status_enum",
            create_constraint=True,
        ),
        nullable=False,
        default="inactive",
    )
    data_path: Mapped[str] = mapped_column(String(500), nullable=False)
    container_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    container_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    total_samples: Mapped[int] = mapped_column(Integer, default=0)
    # Canvas topology binding — links this FL client to its canvas node
    canvas_node_id: Mapped[str | None] = mapped_column(
        String(100), unique=True, nullable=True, index=True
    )
    # Data source used for training: 'cic-ids2017' or 'synthetic'
    data_source: Mapped[str] = mapped_column(
        String(20), nullable=False, default="cic-ids2017"
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    # Persisted RECESS trust score — survives backend restarts
    trust_score: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)

    # Relationships — one client has many devices
    devices: Mapped[list["Device"]] = relationship(
        "Device", back_populates="fl_client", cascade="all, delete-orphan"
    )


class SecurityEventLog(Base):
    """Persisted audit log for security pipeline events emitted by the FL server.

    Mirrors the payload of WSMessageType.SECURITY_EVENT so that every event is
    both broadcast in real-time and durable across backend restarts.
    """

    __tablename__ = "security_event_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    round: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    client_id: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )


class FedRecoveryRun(Base):
    """Record of a single FedRecovery correction run triggered after a client is flagged.

    One run per flagged client per triggering round.  Steps are appended
    incrementally as the engine progresses so the record survives a crash.
    """

    __tablename__ = "fed_recovery_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # UUID string identifying the run, generated by the FL server
    run_id: Mapped[str] = mapped_column(
        String(36), unique=True, nullable=False, index=True
    )
    flagged_client_id: Mapped[str] = mapped_column(
        String(50), nullable=False, index=True
    )
    flag_round: Mapped[int] = mapped_column(Integer, nullable=False)
    rounds_corrected: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rounds_skipped: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(
        SAEnum(
            "running",
            "complete",
            "partial",
            "failed",
            "cancelled",
            name="fed_recovery_status_enum",
            create_constraint=True,
        ),
        nullable=False,
        default="running",
        index=True,
    )
    # Ordered list of step dicts: {round, step, detail, data, timestamp}
    steps: Mapped[list | None] = mapped_column(JSON, nullable=True, default=None)
    # Per-layer weight norms before and after correction
    before_norms: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after_norms: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # DP noise parameters used during correction
    epsilon: Mapped[float | None] = mapped_column(Float, nullable=True)
    sigma: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Model quality deltas
    accuracy_before: Mapped[float | None] = mapped_column(Float, nullable=True)
    accuracy_after: Mapped[float | None] = mapped_column(Float, nullable=True)
    loss_before: Mapped[float | None] = mapped_column(Float, nullable=True)
    loss_after: Mapped[float | None] = mapped_column(Float, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
