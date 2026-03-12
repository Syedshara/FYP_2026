"""
Pipeline API — create, manage, and execute traffic-processing pipelines.

Endpoints:
  GET    /pipelines/                      — list all pipelines
  POST   /pipelines/                      — create a pipeline
  GET    /pipelines/{pipeline_id}         — get one pipeline
  PUT    /pipelines/{pipeline_id}         — update (full canvas save)
  DELETE /pipelines/{pipeline_id}         — delete pipeline
  POST   /pipelines/{pipeline_id}/run     — start execution
  POST   /pipelines/{pipeline_id}/stop    — stop execution
  GET    /pipelines/{pipeline_id}/status  — live status
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_db, get_current_user
from app.services import pipeline_service
from app.schemas.pipeline import (
    PipelineBrief,
    PipelineOut,
    PipelineCreate,
    PipelineUpdate,
    PipelineStatusOut,
)

log = logging.getLogger(__name__)

router = APIRouter()


# ── Endpoints ────────────────────────────────────────────

@router.get("/", response_model=list[PipelineBrief])
async def list_pipelines(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all pipelines (lightweight — no nodes)."""
    return await pipeline_service.list_pipelines(db)


@router.post("/", response_model=PipelineOut)
async def create_pipeline(
    data: PipelineCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Create a new pipeline with an optional initial set of nodes."""
    try:
        return await pipeline_service.create_pipeline(db, data)
    except Exception as exc:
        log.error("Failed to create pipeline: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create pipeline: {exc}")


@router.get("/{pipeline_id}", response_model=PipelineOut)
async def get_pipeline(
    pipeline_id: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get a single pipeline including its nodes."""
    pipeline = await pipeline_service.get_pipeline(db, pipeline_id)
    if pipeline is None:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    return pipeline


@router.put("/{pipeline_id}", response_model=PipelineOut)
async def update_pipeline(
    pipeline_id: int,
    data: PipelineUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Full canvas save — atomically replaces the pipeline name/description
    and the entire node list.
    """
    try:
        pipeline = await pipeline_service.update_pipeline(db, pipeline_id, data)
    except Exception as exc:
        log.error("Failed to update pipeline %s: %s", pipeline_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update pipeline: {exc}")
    if pipeline is None:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    return pipeline


@router.delete("/{pipeline_id}")
async def delete_pipeline(
    pipeline_id: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Delete a pipeline and all its nodes."""
    try:
        deleted = await pipeline_service.delete_pipeline(db, pipeline_id)
    except Exception as exc:
        log.error("Failed to delete pipeline %s: %s", pipeline_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete pipeline: {exc}")
    if not deleted:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    return {"ok": True}


@router.post("/{pipeline_id}/run")
async def run_pipeline(
    pipeline_id: int,
    _user=Depends(get_current_user),
):
    """Start pipeline execution."""
    try:
        return await pipeline_service.run_pipeline(pipeline_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to run pipeline %s: %s", pipeline_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to run pipeline: {exc}")


@router.post("/{pipeline_id}/stop")
async def stop_pipeline(
    pipeline_id: int,
    _user=Depends(get_current_user),
):
    """Stop a running pipeline."""
    try:
        return await pipeline_service.stop_pipeline(pipeline_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to stop pipeline %s: %s", pipeline_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to stop pipeline: {exc}")


@router.get("/{pipeline_id}/status", response_model=PipelineStatusOut)
async def get_pipeline_status(
    pipeline_id: int,
    _user=Depends(get_current_user),
):
    """Get live execution status for a pipeline."""
    try:
        return await pipeline_service.get_pipeline_status(pipeline_id)
    except Exception as exc:
        log.error("Failed to get status for pipeline %s: %s", pipeline_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get pipeline status: {exc}")
