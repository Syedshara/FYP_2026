"""
Pipeline service — CRUD + execution control.

CRUD functions accept an injected ``db: AsyncSession`` (from FastAPI dependency).
Execution functions (run/stop/status) open their own session via ``async_session()``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import async_session
from app.models.pipeline import Pipeline, PipelineNode
from app.schemas.pipeline import PipelineCreate, PipelineUpdate
from app.services import simulation_service
from app.services.simulation_service import SimState

log = logging.getLogger(__name__)

_DEFAULT_CLIENTS = ["bank_a", "bank_b", "bank_c"]


# ── CRUD ─────────────────────────────────────────────────


async def list_pipelines(db: AsyncSession) -> list[Pipeline]:
    """Return all pipelines (nodes NOT eagerly loaded — use for listing)."""
    result = await db.execute(
        select(Pipeline).order_by(Pipeline.created_at.desc())
    )
    return list(result.scalars().all())


async def create_pipeline(db: AsyncSession, data: PipelineCreate) -> Pipeline:
    """
    Create a new pipeline with an optional initial set of nodes.

    Nodes are inserted in the order supplied; positions/edges come straight
    from the schema so the React Flow canvas round-trips cleanly.
    """
    pipeline = Pipeline(
        name=data.name,
        description=data.description,
        status="idle",
    )
    db.add(pipeline)
    await db.flush()  # populate pipeline.id before creating nodes

    for node_data in data.nodes:
        node = PipelineNode(
            pipeline_id=pipeline.id,
            node_key=node_data.node_key,
            node_type=node_data.node_type,
            label=node_data.label,
            config=node_data.config,
            position_x=node_data.position_x,
            position_y=node_data.position_y,
            edges_json=node_data.edges_json,
        )
        db.add(node)

    await db.commit()
    # Reload with nodes so the returned object is fully populated
    result = await db.execute(
        select(Pipeline)
        .options(selectinload(Pipeline.nodes))
        .where(Pipeline.id == pipeline.id)
    )
    return result.scalar_one()


async def get_pipeline(db: AsyncSession, pipeline_id: int) -> Pipeline | None:
    """Return a single pipeline with its nodes, or None if not found."""
    result = await db.execute(
        select(Pipeline)
        .options(selectinload(Pipeline.nodes))
        .where(Pipeline.id == pipeline_id)
    )
    return result.scalar_one_or_none()


async def update_pipeline(
    db: AsyncSession, pipeline_id: int, data: PipelineUpdate
) -> Pipeline | None:
    """
    Update a pipeline's metadata and optionally replace its nodes atomically.

    If ``data.nodes`` is provided: delete all existing PipelineNode rows for
    this pipeline, then insert fresh ones.
    If ``data.nodes`` is None: leave nodes untouched, only update name/description.
    """
    result = await db.execute(
        select(Pipeline)
        .options(selectinload(Pipeline.nodes))
        .where(Pipeline.id == pipeline_id)
    )
    pipeline = result.scalar_one_or_none()
    if pipeline is None:
        return None

    # Update scalar fields when supplied
    if data.name is not None:
        pipeline.name = data.name
    if data.description is not None:
        pipeline.description = data.description

    pipeline.updated_at = datetime.now(timezone.utc)

    # Atomic node replace
    if data.nodes is not None:
        await db.execute(
            delete(PipelineNode).where(PipelineNode.pipeline_id == pipeline_id)
        )
        for node_data in data.nodes:
            node = PipelineNode(
                pipeline_id=pipeline.id,
                node_key=node_data.node_key,
                node_type=node_data.node_type,
                label=node_data.label,
                config=node_data.config,
                position_x=node_data.position_x,
                position_y=node_data.position_y,
                edges_json=node_data.edges_json,
            )
            db.add(node)

    await db.commit()

    # Reload with fresh nodes
    result = await db.execute(
        select(Pipeline)
        .options(selectinload(Pipeline.nodes))
        .where(Pipeline.id == pipeline_id)
    )
    return result.scalar_one()


async def delete_pipeline(db: AsyncSession, pipeline_id: int) -> bool:
    """
    Delete a pipeline and all its nodes (cascade handled by ORM).
    Returns True if a row was deleted, False if the pipeline did not exist.
    """
    result = await db.execute(
        select(Pipeline).where(Pipeline.id == pipeline_id)
    )
    pipeline = result.scalar_one_or_none()
    if pipeline is None:
        return False

    await db.delete(pipeline)
    await db.commit()
    return True


# ── Execution ────────────────────────────────────────────


async def run_pipeline(pipeline_id: int) -> dict:
    """
    Start the simulation represented by this pipeline.

    Reads the pipeline + nodes from the DB, extracts source_scenario and
    monitor_sink config, and delegates to simulation_service.start_simulation().
    Updates Pipeline.status to "running" on success.
    """
    async with async_session() as db:
        result = await db.execute(
            select(Pipeline)
            .options(selectinload(Pipeline.nodes))
            .where(Pipeline.id == pipeline_id)
        )
        pipeline = result.scalar_one_or_none()
        if pipeline is None:
            raise ValueError(f"Pipeline {pipeline_id} not found")

        # ── Locate source_scenario node ──
        source_node = next(
            (n for n in pipeline.nodes if n.node_type == "source_scenario"), None
        )
        if source_node is None:
            raise ValueError(
                f"Pipeline {pipeline_id} has no source_scenario node — "
                "cannot determine simulation parameters"
            )

        source_cfg: dict = source_node.config or {}

        # ── Locate optional monitor_sink node ──
        sink_node = next(
            (n for n in pipeline.nodes if n.node_type == "monitor_sink"), None
        )
        sink_cfg: dict = sink_node.config if sink_node else {}

        # ── Build call arguments ──
        scenario: str = source_cfg.get("scenario", "mixed_traffic") or "mixed_traffic"
        duration: str = source_cfg.get("duration", "continuous") or "continuous"

        if sink_node and sink_cfg.get("clients"):
            clients: list[str] = list(sink_cfg["clients"])
        else:
            clients = list(_DEFAULT_CLIENTS)

        log.info(
            "run_pipeline(%d): scenario=%s  duration=%s  clients=%s",
            pipeline_id, scenario, duration, clients,
        )

        # ── Start simulation ──
        await simulation_service.start_simulation(
            scenario=scenario,
            duration=duration,
            client_ids=clients,
        )

        # ── Mark pipeline as running ──
        pipeline.status = "running"
        pipeline.updated_at = datetime.now(timezone.utc)
        await db.commit()

    return {"ok": True, "pipeline_id": pipeline_id}


async def stop_pipeline(pipeline_id: int) -> dict:
    """
    Stop the running simulation and mark the pipeline idle.
    """
    await simulation_service.stop_simulation()

    async with async_session() as db:
        result = await db.execute(
            select(Pipeline).where(Pipeline.id == pipeline_id)
        )
        pipeline = result.scalar_one_or_none()
        if pipeline is not None:
            pipeline.status = "idle"
            pipeline.updated_at = datetime.now(timezone.utc)
            await db.commit()

    return {"ok": True, "pipeline_id": pipeline_id}


async def get_pipeline_status(pipeline_id: int) -> dict:
    """
    Return the live execution status of a pipeline.

    Merges the DB pipeline record with the in-memory simulation state so the
    caller gets a single ``PipelineStatusOut``-shaped dict.
    """
    async with async_session() as db:
        result = await db.execute(
            select(Pipeline).where(Pipeline.id == pipeline_id)
        )
        pipeline = result.scalar_one_or_none()

    if pipeline is None:
        raise ValueError(f"Pipeline {pipeline_id} not found")

    sim_status = simulation_service.get_status()

    active_clients: list[str] = [
        c.client_id
        for c in sim_status.clients
        if c.state == SimState.RUNNING
    ]

    return {
        "pipeline_id": pipeline_id,
        "status": pipeline.status,
        "active_clients": active_clients,
        "scenario": sim_status.config.scenario or None,
        "uptime_seconds": sim_status.uptime_seconds if sim_status.uptime_seconds else None,
        "error_message": None,
    }
