"""
Attack engine models — tracks attack configurations and execution runs.

An Attack is a saved attack template (attack type, parameters, target device).
An AttackRun is a single execution of an Attack via a Docker container.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import Integer, Float, String, Text, DateTime, JSON, ForeignKey, Boolean
from sqlalchemy import Enum as SAEnum, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


# ── Enum values ──────────────────────────────────────────

_ATTACK_CATEGORIES = (
    "ddos",
    "mitm",
    "port-scan",
    "replay",
    "malformed",
    "botnet",
    "iot-protocol",
)

_ATTACK_RUN_STATUSES = (
    "pending",
    "starting",
    "running",
    "stopping",
    "completed",
    "failed",
    "cancelled",
)


class Attack(Base):
    """
    A saved attack configuration template.

    category: one of the 7 attack categories
    sub_type: specific variant (e.g., "syn_flood", "arp_spoof", "mqtt_publish")
    params: free-form JSON blob for attack-specific parameters
    """

    __tablename__ = "attacks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    category: Mapped[str] = mapped_column(
        SAEnum(
            *_ATTACK_CATEGORIES,
            name="attack_category_enum",
            create_constraint=True,
            create_type=False,
        ),
        nullable=False,
    )

    sub_type: Mapped[str] = mapped_column(String(80), nullable=False)

    # Target device IP / network (used by Scapy scripts)
    target_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    target_port: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Attack-specific parameters blob
    params: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)

    # Owner
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
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

    # Relationships
    runs: Mapped[list["AttackRun"]] = relationship(
        back_populates="attack",
        cascade="all, delete-orphan",
        order_by="AttackRun.started_at.desc()",
    )


class AttackRun(Base):
    """
    A single execution of an attack — backed by a Docker container.

    Tracks container lifecycle: pending → starting → running → completed/failed/cancelled.
    Stores results and captured packet counts.
    """

    __tablename__ = "attack_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    attack_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("attacks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    status: Mapped[str] = mapped_column(
        SAEnum(
            *_ATTACK_RUN_STATUSES,
            name="attack_run_status_enum",
            create_constraint=True,
            create_type=False,
        ),
        nullable=False,
        default="pending",
    )

    # Docker container identity
    container_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    container_name: Mapped[str | None] = mapped_column(String(120), nullable=True)

    # Duration and packet stats
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    packets_sent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    packets_captured: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # IDS detection results (populated after inference pipeline runs)
    detections: Mapped[int | None] = mapped_column(Integer, nullable=True)
    detection_rate: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Results blob (detailed per-packet or per-batch results)
    results: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)

    # Error message if failed
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    attack: Mapped["Attack"] = relationship(back_populates="runs")
