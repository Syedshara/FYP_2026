"""
Device model — represents an IoT device being monitored.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import String, Integer, Text, DateTime, Enum as SAEnum, Uuid, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.fl import FLClient
    from app.models.prediction import Prediction


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(
        String(100), unique=True, nullable=False, index=True
    )
    device_type: Mapped[str] = mapped_column(
        SAEnum(
            "camera", "sensor", "gateway", "actuator",
            "smart_plug", "custom",
            name="device_type_enum",
            create_constraint=True,
        ),
        nullable=False,
    )
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    protocol: Mapped[str] = mapped_column(
        SAEnum("mqtt", "coap", "http", "tcp", "udp", name="protocol_enum"),
        nullable=False,
    )
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        SAEnum(
            "online", "offline", "quarantined", "under_attack",
            name="device_status_enum",
        ),
        nullable=False,
        default="offline",
    )
    traffic_source: Mapped[str] = mapped_column(
        SAEnum(
            "live_capture", "pcap_upload", "simulated",
            name="traffic_source_enum",
        ),
        nullable=False,
        default="simulated",
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # FK — which FL client owns this device (nullable for standalone devices)
    client_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("fl_clients.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    threat_count_today: Mapped[int] = mapped_column(Integer, default=0)
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
    fl_client: Mapped[FLClient | None] = relationship(
        "FLClient", back_populates="devices"
    )
    predictions: Mapped[list[Prediction]] = relationship(
        "Prediction", back_populates="device", cascade="all, delete-orphan"
    )
