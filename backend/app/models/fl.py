"""
FL round + client metrics models.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import Integer, Float, String, Boolean, DateTime, Text, Enum as SAEnum, ForeignKey
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

    # Relationships
    client_metrics: Mapped[list["FLClientMetric"]] = relationship(
        back_populates="round", cascade="all, delete-orphan"
    )


class FLClientMetric(Base):
    __tablename__ = "fl_client_metrics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    round_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("fl_rounds.id", ondelete="CASCADE"), nullable=False, index=True
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
    name: Mapped[str] = mapped_column(
        String(100), nullable=False, default=""
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    status: Mapped[str] = mapped_column(
        SAEnum(
            "active", "inactive", "training", "error",
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

    # Relationships — one client has many devices
    devices: Mapped[list["Device"]] = relationship(
        "Device", back_populates="fl_client", cascade="all, delete-orphan"
    )
