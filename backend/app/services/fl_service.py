"""
Federated Learning service — manages FL training rounds, metrics, and clients.
"""

from datetime import datetime, timezone
from typing import Optional
import logging

from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.fl import FLRound, FLClientMetric, FLClient
from app.core.exceptions import NotFoundException, ConflictException
from app.services import docker_service, data_service

log = logging.getLogger(__name__)


# ── FL Rounds ────────────────────────────────────────────

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


# ── FL Client CRUD ──────────────────────────────────────

async def register_fl_client(
    db: AsyncSession,
    client_id: str,
    name: str,
    data_path: str = "/app/data",
    description: Optional[str] = None,
    ip_address: Optional[str] = None,
    create_container: bool = True,
) -> FLClient:
    """
    Register a new FL client.
    If create_container=True, also creates a Docker container for it.
    Raises ConflictException if client_id exists.
    """
    result = await db.execute(
        select(FLClient).where(FLClient.client_id == client_id)
    )
    existing = result.scalar_one_or_none()
    if existing:
        raise ConflictException(f"FL client with ID '{client_id}' already exists")

    container_id = None
    container_name = None

    # ── Generate training data (copy 30% subset from a source client) ──
    data_info = data_service.generate_client_data(client_id)
    total_samples = data_info.get("total_samples", 0)
    if data_info.get("created"):
        log.info(
            "Generated training data for %s: %d chunks, %d samples (source: %s)",
            client_id, data_info["chunks"], total_samples, data_info["source"],
        )
    elif not data_info.get("created") and data_info.get("source") == "existing":
        # Data already existed — count samples
        existing_info = data_service.get_client_data_info(client_id)
        total_samples = existing_info.get("total_samples", 0)

    if create_container:
        try:
            info = docker_service.create_client_container(
                client_id=client_id,
                data_path=data_path,
            )
            container_id = info.container_id
            container_name = info.name
            log.info("Created container %s for client %s", container_name, client_id)
        except Exception as exc:
            log.error("Failed to create container for %s: %s", client_id, exc)
            # Still register the client but without a container
            container_id = None
            container_name = None

    client = FLClient(
        client_id=client_id,
        name=name,
        description=description,
        ip_address=ip_address,
        data_path=data_path,
        status="inactive",
        container_id=container_id,
        container_name=container_name,
        total_samples=total_samples,
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(client)
    await db.commit()
    await db.refresh(client)
    return client


async def get_fl_client(db: AsyncSession, pk: int) -> FLClient:
    """Get a single FL client by primary key, with devices eagerly loaded."""
    result = await db.execute(
        select(FLClient)
        .options(selectinload(FLClient.devices))
        .where(FLClient.id == pk)
    )
    client = result.scalar_one_or_none()
    if not client:
        raise NotFoundException("FL client not found")
    return client


async def get_fl_client_by_client_id(db: AsyncSession, client_id: str) -> Optional[FLClient]:
    """Get a single FL client by its short client_id string."""
    result = await db.execute(
        select(FLClient).where(FLClient.client_id == client_id)
    )
    return result.scalar_one_or_none()


async def update_fl_client(
    db: AsyncSession,
    pk: int,
    **kwargs,
) -> FLClient:
    """Update FL client fields."""
    client = await get_fl_client(db, pk)
    for key, value in kwargs.items():
        if value is not None and hasattr(client, key):
            setattr(client, key, value)
    await db.commit()
    await db.refresh(client)
    return client


async def delete_fl_client(db: AsyncSession, pk: int) -> None:
    """Delete an FL client, remove its Docker container, and cascade-delete its devices."""
    client = await get_fl_client(db, pk)

    # Remove Docker container if one was created
    if client.container_id:
        try:
            docker_service.remove_container(client.container_id, force=True)
            log.info("Removed container %s for client %s", client.container_id, client.client_id)
        except Exception as exc:
            log.error("Failed to remove container for %s: %s", client.client_id, exc)

    # Remove training data directory (safety: won't delete source clients)
    data_service.delete_client_data(client.client_id)

    await db.delete(client)
    await db.commit()


async def get_all_fl_clients(db: AsyncSession) -> list[FLClient]:
    """Return all registered FL clients."""
    result = await db.execute(
        select(FLClient).order_by(FLClient.created_at.desc())
    )
    return list(result.scalars().all())


async def get_active_fl_clients(db: AsyncSession) -> list[FLClient]:
    """Return only active FL clients."""
    result = await db.execute(
        select(FLClient).where(FLClient.status == "active").order_by(FLClient.client_id)
    )
    return list(result.scalars().all())


# ── Cleanup ─────────────────────────────────────────────

async def delete_fl_round_data(db: AsyncSession) -> int:
    """Delete all FL round and metric data (reset). Returns count deleted."""
    metrics_result = await db.execute(select(func.count(FLClientMetric.id)))
    metrics_count = metrics_result.scalar() or 0

    rounds_result = await db.execute(select(func.count(FLRound.id)))
    rounds_count = rounds_result.scalar() or 0

    await db.execute(delete(FLClientMetric))
    await db.execute(delete(FLRound))
    await db.commit()

    return rounds_count + metrics_count
