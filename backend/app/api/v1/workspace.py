"""
Workspace API — create, load, save, and delete canvas workspaces.

Endpoints:
  GET    /workspaces/              — list user's workspaces
  POST   /workspaces/              — create a workspace
  GET    /workspaces/{id}          — load workspace (nodes + edges + viewport)
  PUT    /workspaces/{id}          — full canvas save (atomic replace)
  DELETE /workspaces/{id}          — delete workspace
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_db, get_current_user
from app.models.user import User
from app.services import workspace_service
from app.schemas.workspace import (
    WorkspaceBrief,
    WorkspaceOut,
    WorkspaceCreate,
    WorkspaceSave,
    ViewportState,
)

log = logging.getLogger(__name__)

router = APIRouter()


def _workspace_to_out(ws) -> dict:
    """Convert a Workspace ORM object to WorkspaceOut-compatible dict."""
    return {
        "id": ws.id,
        "name": ws.name,
        "description": ws.description,
        "viewport": ViewportState(
            x=ws.viewport_x,
            y=ws.viewport_y,
            zoom=ws.viewport_zoom,
        ),
        "created_at": ws.created_at,
        "updated_at": ws.updated_at,
        "nodes": ws.nodes,
        "edges": ws.edges,
    }


# ── Endpoints ────────────────────────────────────────────


@router.get("/", response_model=list[WorkspaceBrief])
async def list_workspaces(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List all workspaces for the current user (lightweight — no nodes)."""
    return await workspace_service.list_workspaces(db, user.id)


@router.post("/", response_model=WorkspaceOut)
async def create_workspace(
    data: WorkspaceCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a new workspace with optional initial nodes and edges."""
    try:
        ws = await workspace_service.create_workspace(db, user.id, data)
        return _workspace_to_out(ws)
    except Exception as exc:
        log.error("Failed to create workspace: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create workspace: {exc}")


@router.get("/{workspace_id}", response_model=WorkspaceOut)
async def get_workspace(
    workspace_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Load a single workspace including all nodes and edges."""
    ws = await workspace_service.get_workspace(db, workspace_id)
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return _workspace_to_out(ws)


@router.put("/{workspace_id}", response_model=WorkspaceOut)
async def save_workspace(
    workspace_id: int,
    data: WorkspaceSave,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """
    Full canvas save — atomically replaces nodes, edges, viewport, and metadata.
    """
    try:
        ws = await workspace_service.save_workspace(db, workspace_id, data)
    except Exception as exc:
        log.error("Failed to save workspace %s: %s", workspace_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to save workspace: {exc}")
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return _workspace_to_out(ws)


@router.delete("/{workspace_id}")
async def delete_workspace(
    workspace_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Delete a workspace and all its nodes and edges."""
    try:
        deleted = await workspace_service.delete_workspace(db, workspace_id)
    except Exception as exc:
        log.error("Failed to delete workspace %s: %s", workspace_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete workspace: {exc}")
    if not deleted:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return {"ok": True}
