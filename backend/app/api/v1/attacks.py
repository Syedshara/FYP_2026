"""
Attack engine API — CRUD for attack templates + execution run management.

Endpoints:
  GET    /attacks/catalog              — list available attack types/variants
  GET    /attacks/                     — list user's attack templates
  POST   /attacks/                     — create an attack template
  GET    /attacks/{id}                 — get attack template (with runs)
  PATCH  /attacks/{id}                 — update attack template
  DELETE /attacks/{id}                 — delete attack template

  POST   /attacks/{id}/run             — execute attack (spawn Docker container)
  POST   /attacks/{id}/stop/{run_id}   — stop a running attack
  GET    /attacks/{id}/runs            — list runs for an attack
  GET    /attacks/{id}/runs/{run_id}   — get single run details
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_db, get_current_user
from app.core.websocket import ws_manager
from app.models.user import User
from app.services import attack_service
from app.services.inference_service import run_capture_inference_pipeline
from app.schemas.attack import (
    AttackCreate,
    AttackUpdate,
    AttackOut,
    AttackBrief,
    AttackRunRequest,
    AttackRunOut,
    AttackRunBrief,
    AttackCatalog,
    AttackVariant,
)

log = logging.getLogger(__name__)


# ── Pipeline manager ─────────────────────────────────────
# Tracks running capture-inference pipelines keyed by run_id.
# Each entry holds the asyncio.Task and a stop Event so the
# pipeline can be cleanly terminated when the attack stops.


@dataclass
class _PipelineHandle:
    task: asyncio.Task[dict[str, Any]]
    stop_event: asyncio.Event


# Module-level registry — survives across requests within the same process.
_active_pipelines: dict[int, _PipelineHandle] = {}


def start_pipeline(run_id: int, attack_id: int) -> None:
    """Launch capture-inference pipeline as a background asyncio task."""
    if run_id in _active_pipelines:
        log.warning("Pipeline for run %d already active — skipping", run_id)
        return

    stop_event = asyncio.Event()

    async def _wrapper() -> dict[str, Any]:
        try:
            result = await run_capture_inference_pipeline(
                stop_event=stop_event,
                run_id=run_id,
                attack_id=attack_id,
                broadcast_fn=ws_manager.broadcast,
            )
            return result
        except Exception as exc:
            log.error("Pipeline for run %d crashed: %s", run_id, exc, exc_info=True)
            return {"error": str(exc)}
        finally:
            _active_pipelines.pop(run_id, None)
            log.info("Pipeline for run %d removed from active registry", run_id)

    task = asyncio.get_event_loop().create_task(_wrapper(), name=f"pipeline-run-{run_id}")
    _active_pipelines[run_id] = _PipelineHandle(task=task, stop_event=stop_event)
    log.info("Capture-inference pipeline started for run %d", run_id)


def stop_pipeline(run_id: int) -> None:
    """Signal a running pipeline to stop. Non-blocking; the task will clean up."""
    handle = _active_pipelines.get(run_id)
    if handle is None:
        return
    if not handle.stop_event.is_set():
        handle.stop_event.set()
        log.info("Stop signal sent to pipeline for run %d", run_id)


def is_pipeline_active(run_id: int) -> bool:
    return run_id in _active_pipelines

router = APIRouter()


# ── Catalog ──────────────────────────────────────────────


@router.get("/catalog", response_model=AttackCatalog)
async def get_catalog():
    """List all available attack categories and their variants."""
    raw = attack_service.get_attack_catalog()
    categories = {
        cat: [AttackVariant(**v) for v in variants]
        for cat, variants in raw.items()
    }
    return AttackCatalog(categories=categories)


# ── Attack Template CRUD ─────────────────────────────────


@router.get("/", response_model=list[AttackBrief])
async def list_attacks(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List all attack templates for the current user."""
    return await attack_service.list_attacks(db, user.id)


@router.post("/", response_model=AttackOut)
async def create_attack(
    data: AttackCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a new attack template."""
    try:
        attack = await attack_service.create_attack(db, user.id, data)
        return attack
    except Exception as exc:
        log.error("Failed to create attack: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create attack: {exc}")


@router.get("/{attack_id}", response_model=AttackOut)
async def get_attack(
    attack_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Get a single attack template with its runs."""
    attack = await attack_service.get_attack(db, attack_id)
    if attack is None:
        raise HTTPException(status_code=404, detail="Attack not found")
    return attack


@router.patch("/{attack_id}", response_model=AttackOut)
async def update_attack(
    attack_id: int,
    data: AttackUpdate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Update an attack template."""
    try:
        attack = await attack_service.update_attack(db, attack_id, data)
    except Exception as exc:
        log.error("Failed to update attack %s: %s", attack_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update attack: {exc}")
    if attack is None:
        raise HTTPException(status_code=404, detail="Attack not found")
    return attack


@router.delete("/{attack_id}")
async def delete_attack(
    attack_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Delete an attack template and all its runs."""
    try:
        deleted = await attack_service.delete_attack(db, attack_id)
    except Exception as exc:
        log.error("Failed to delete attack %s: %s", attack_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete attack: {exc}")
    if not deleted:
        raise HTTPException(status_code=404, detail="Attack not found")
    return {"ok": True}


# ── Attack Execution ─────────────────────────────────────


@router.post("/{attack_id}/run", response_model=AttackRunOut)
async def run_attack(
    attack_id: int,
    data: AttackRunRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """
    Execute an attack — spawns a Docker container running the Scapy attack script.
    """
    attack = await attack_service.get_attack(db, attack_id)
    if attack is None:
        raise HTTPException(status_code=404, detail="Attack not found")

    # Create run record
    run = await attack_service.create_run(db, attack, data)

    # Spawn container
    try:
        container_info = attack_service.spawn_attack_container(attack, run, data)
        run = await attack_service.update_run_status(
            db, run.id,
            status="running",
            container_id=container_info["container_id"],
            container_name=container_info["container_name"],
        )
    except RuntimeError as exc:
        run = await attack_service.update_run_status(
            db, run.id,
            status="failed",
            error_message=str(exc),
            finished=True,
        )
        raise HTTPException(status_code=500, detail=str(exc))

    # Start the capture → feature-extraction → inference pipeline
    # as a background asyncio task. It captures traffic on the Docker
    # bridge while the attack container is running and streams
    # real-time IDS predictions via WebSocket.
    try:
        start_pipeline(run_id=run.id, attack_id=attack.id)
    except Exception as exc:
        # Pipeline failure is non-fatal — the attack still runs,
        # but live inference won't be available for this run.
        log.warning("Failed to start capture pipeline for run %d: %s", run.id, exc)

    return run


@router.post("/{attack_id}/stop/{run_id}", response_model=AttackRunOut)
async def stop_attack_run(
    attack_id: int,
    run_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Stop a running attack execution."""
    run = await attack_service.get_run(db, run_id)
    if run is None or run.attack_id != attack_id:
        raise HTTPException(status_code=404, detail="Attack run not found")

    if run.status not in ("running", "starting"):
        raise HTTPException(status_code=400, detail=f"Run is not active (status={run.status})")

    # Stop the capture-inference pipeline first (non-blocking signal)
    stop_pipeline(run_id)

    # Stop the container
    if run.container_id:
        attack_service.stop_attack_container(run.container_id)

    run = await attack_service.update_run_status(
        db, run.id,
        status="cancelled",
        finished=True,
    )
    return run


@router.get("/{attack_id}/runs", response_model=list[AttackRunBrief])
async def list_runs(
    attack_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """List all runs for an attack template."""
    return await attack_service.list_runs(db, attack_id)


@router.get("/{attack_id}/runs/{run_id}", response_model=AttackRunOut)
async def get_run(
    attack_id: int,
    run_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Get a single run's details."""
    run = await attack_service.get_run(db, run_id)
    if run is None or run.attack_id != attack_id:
        raise HTTPException(status_code=404, detail="Attack run not found")
    return run
