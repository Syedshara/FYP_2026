"""
Prediction model — stores ML inference results.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import Integer, Float, String, BigInteger, DateTime, Enum as SAEnum, Uuid, JSON, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

import uuid

from app.database import Base

if TYPE_CHECKING:
    from app.models.device import Device


class Prediction(Base):
    __tablename__ = "predictions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    device_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    client_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("fl_clients.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    traffic_log_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    label: Mapped[str] = mapped_column(
        SAEnum("benign", "attack", name="prediction_label_enum", create_constraint=True),
        nullable=False,
    )
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    attack_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    model_version: Mapped[str] = mapped_column(String(100), nullable=False)
    window_start_idx: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    window_end_idx: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    feature_importance: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    top_anomalies: Mapped[list | None] = mapped_column(JSON, nullable=True)
    temporal_pattern: Mapped[str | None] = mapped_column(String(100), nullable=True)
    inference_latency_ms: Mapped[float] = mapped_column(Float, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    device: Mapped[Device] = relationship("Device", back_populates="predictions")
