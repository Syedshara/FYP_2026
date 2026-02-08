"""
FL round + client metrics models.
"""

from datetime import datetime, timezone

from sqlalchemy import Integer, Float, String, Boolean, DateTime, Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class FLRound(Base):
    __tablename__ = "fl_rounds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    round_number: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
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


class FLClientMetric(Base):
    __tablename__ = "fl_client_metrics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    round_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    client_id: Mapped[str] = mapped_column(String(50), nullable=False)
    local_loss: Mapped[float] = mapped_column(Float, nullable=False)
    local_accuracy: Mapped[float] = mapped_column(Float, nullable=False)
    num_samples: Mapped[int] = mapped_column(Integer, nullable=False)
    training_time_sec: Mapped[float] = mapped_column(Float, nullable=False)
    encrypted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class FLClient(Base):
    """Registered FL clients — used for dynamic add/remove."""
    __tablename__ = "fl_clients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(
        String(50), unique=True, nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(
        SAEnum("active", "inactive", "training", name="fl_client_status_enum"),
        nullable=False,
        default="inactive",
    )
    data_path: Mapped[str] = mapped_column(String(500), nullable=False)
    container_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
