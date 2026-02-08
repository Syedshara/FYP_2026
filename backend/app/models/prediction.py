"""
Prediction model — stores ML inference results.
"""

from datetime import datetime, timezone

from sqlalchemy import Integer, Float, String, BigInteger, DateTime, Enum as SAEnum, Uuid, JSON
from sqlalchemy.orm import Mapped, mapped_column

import uuid

from app.database import Base


class Prediction(Base):
    __tablename__ = "predictions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    device_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), nullable=False, index=True
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
    inference_latency_ms: Mapped[float] = mapped_column(Float, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
