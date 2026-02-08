"""
Federated Learning service — manages FL training rounds and metrics.
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.fl import FLRound, FLClientMetric, FLClient


async def create_fl_round(
    db: AsyncSession,
    round_number: int,
    num_clients: int,
    aggregation_method: str = "fedavg_he",
    he_scheme: Optional[str] = "ckks",
    he_poly_modulus: Optional[int] = 16384,
    duration_seconds: Optional[float] = None,
    global_loss: Optional[float] = None,
    global_accuracy: Optional[float] = None,
    global_f1: Optional[float] = None,
    global_precision: Optional[float] = None,
    global_recall: Optional[float] = None,
    model_checkpoint_path: Optional[str] = None,
) -> FLRound:
    """Record a completed FL round."""
    fl_round = FLRound(
        round_number=round_number,
        num_clients=num_clients,
        aggregation_method=aggregation_method,
        he_scheme=he_scheme,
        he_poly_modulus=he_poly_modulus,
        duration_seconds=duration_seconds,
        global_loss=global_loss,
        global_accuracy=global_accuracy,
        global_f1=global_f1,
        global_precision=global_precision,
        global_recall=global_recall,
        model_checkpoint_path=model_checkpoint_path,
    )
    db.add(fl_round)
    await db.commit()
    await db.refresh(fl_round)
    return fl_round


async def create_client_metric(
    db: AsyncSession,
    round_id: int,
    client_id: str,
    local_loss: float,
    local_accuracy: float,
    num_samples: int,
    training_time_sec: float,
    encrypted: bool = True,
) -> FLClientMetric:
    """Record a client's training metrics for a given round."""
    metric = FLClientMetric(
        round_id=round_id,
        client_id=client_id,
        local_loss=local_loss,
        local_accuracy=local_accuracy,
        num_samples=num_samples,
        training_time_sec=training_time_sec,
        encrypted=encrypted,
    )
    db.add(metric)
    await db.commit()
    await db.refresh(metric)
    return metric


async def get_all_rounds(db: AsyncSession) -> list[FLRound]:
    """Return all FL rounds ordered by round number."""
    result = await db.execute(
        select(FLRound).order_by(FLRound.round_number)
    )
    return list(result.scalars().all())


async def get_round_by_number(db: AsyncSession, round_number: int) -> Optional[FLRound]:
    """Get a specific round by its number."""
    result = await db.execute(
        select(FLRound).where(FLRound.round_number == round_number)
    )
    return result.scalar_one_or_none()


async def get_client_metrics_for_round(
    db: AsyncSession, round_id: int
) -> list[FLClientMetric]:
    """Get all client metrics for a given round."""
    result = await db.execute(
        select(FLClientMetric).where(FLClientMetric.round_id == round_id)
    )
    return list(result.scalars().all())


async def get_latest_round(db: AsyncSession) -> Optional[FLRound]:
    """Get the most recent FL round."""
    result = await db.execute(
        select(FLRound).order_by(FLRound.round_number.desc()).limit(1)
    )
    return result.scalar_one_or_none()


# ── FL Client registry ──────────────────────────────────

async def register_fl_client(
    db: AsyncSession,
    client_id: str,
    data_path: str,
) -> FLClient:
    """Register or update an FL client."""
    result = await db.execute(
        select(FLClient).where(FLClient.client_id == client_id)
    )
    existing = result.scalar_one_or_none()

    if existing:
        existing.data_path = data_path
        existing.status = "active"
        existing.last_seen_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing)
        return existing

    client = FLClient(
        client_id=client_id,
        data_path=data_path,
        status="active",
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(client)
    await db.commit()
    await db.refresh(client)
    return client


async def get_all_fl_clients(db: AsyncSession) -> list[FLClient]:
    """Return all registered FL clients."""
    result = await db.execute(select(FLClient).order_by(FLClient.client_id))
    return list(result.scalars().all())


async def get_active_fl_clients(db: AsyncSession) -> list[FLClient]:
    """Return only active FL clients."""
    result = await db.execute(
        select(FLClient).where(FLClient.status == "active").order_by(FLClient.client_id)
    )
    return list(result.scalars().all())


async def delete_fl_round_data(db: AsyncSession) -> int:
    """Delete all FL round and metric data (reset). Returns count deleted."""
    metrics_result = await db.execute(select(func.count(FLClientMetric.id)))
    metrics_count = metrics_result.scalar() or 0

    rounds_result = await db.execute(select(func.count(FLRound.id)))
    rounds_count = rounds_result.scalar() or 0

    await db.execute(select(FLClientMetric).execution_options(synchronize_session=False))
    await db.execute(select(FLRound).execution_options(synchronize_session=False))

    # Use delete statements
    from sqlalchemy import delete
    await db.execute(delete(FLClientMetric))
    await db.execute(delete(FLRound))
    await db.commit()

    return rounds_count + metrics_count
