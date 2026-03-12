"""
Workspace service — CRUD for the unified canvas state.

All functions accept an injected ``db: AsyncSession`` from FastAPI dependency.
Save is atomic: on PUT, all nodes and edges are replaced in a single transaction.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.workspace import Workspace, WorkspaceNode, WorkspaceEdge
from app.schemas.workspace import WorkspaceCreate, WorkspaceSave

log = logging.getLogger(__name__)


# ── CRUD ─────────────────────────────────────────────────


async def list_workspaces(db: AsyncSession, user_id) -> list[Workspace]:
    """Return all workspaces for a user (lightweight — no nodes/edges)."""
    result = await db.execute(
        select(Workspace)
        .where(Workspace.user_id == user_id)
        .order_by(Workspace.updated_at.desc())
    )
    return list(result.scalars().all())


async def create_workspace(
    db: AsyncSession, user_id, data: WorkspaceCreate
) -> Workspace:
    """Create a new workspace with optional initial nodes and edges."""
    workspace = Workspace(
        name=data.name,
        description=data.description,
        user_id=user_id,
        viewport_x=data.viewport.x,
        viewport_y=data.viewport.y,
        viewport_zoom=data.viewport.zoom,
    )
    db.add(workspace)
    await db.flush()  # populate workspace.id

    for nd in data.nodes:
        db.add(WorkspaceNode(
            workspace_id=workspace.id,
            node_key=nd.node_key,
            node_type=nd.node_type,
            position_x=nd.position_x,
            position_y=nd.position_y,
            data=nd.data,
        ))

    for ed in data.edges:
        db.add(WorkspaceEdge(
            workspace_id=workspace.id,
            edge_key=ed.edge_key,
            edge_type=ed.edge_type,
            source_key=ed.source_key,
            target_key=ed.target_key,
            data=ed.data,
        ))

    await db.commit()
    return await _reload(db, workspace.id)


async def get_workspace(db: AsyncSession, workspace_id: int) -> Workspace | None:
    """Return a single workspace with its nodes and edges, or None."""
    result = await db.execute(
        select(Workspace)
        .options(selectinload(Workspace.nodes), selectinload(Workspace.edges))
        .where(Workspace.id == workspace_id)
    )
    return result.scalar_one_or_none()


async def save_workspace(
    db: AsyncSession, workspace_id: int, data: WorkspaceSave
) -> Workspace | None:
    """
    Full canvas save — atomically replace nodes, edges, viewport, and metadata.

    If ``data.nodes`` is provided: delete all existing rows, insert fresh ones.
    If ``data.edges`` is provided: same treatment.
    Scalars (name, description, viewport) are updated only when non-None.
    """
    result = await db.execute(
        select(Workspace)
        .options(selectinload(Workspace.nodes), selectinload(Workspace.edges))
        .where(Workspace.id == workspace_id)
    )
    workspace = result.scalar_one_or_none()
    if workspace is None:
        return None

    # ── Scalar updates ──
    if data.name is not None:
        workspace.name = data.name
    if data.description is not None:
        workspace.description = data.description
    if data.viewport is not None:
        workspace.viewport_x = data.viewport.x
        workspace.viewport_y = data.viewport.y
        workspace.viewport_zoom = data.viewport.zoom

    workspace.updated_at = datetime.now(timezone.utc)

    # ── Atomic node replace ──
    if data.nodes is not None:
        await db.execute(
            delete(WorkspaceNode).where(WorkspaceNode.workspace_id == workspace_id)
        )
        for nd in data.nodes:
            db.add(WorkspaceNode(
                workspace_id=workspace.id,
                node_key=nd.node_key,
                node_type=nd.node_type,
                position_x=nd.position_x,
                position_y=nd.position_y,
                data=nd.data,
            ))

    # ── Atomic edge replace ──
    if data.edges is not None:
        await db.execute(
            delete(WorkspaceEdge).where(WorkspaceEdge.workspace_id == workspace_id)
        )
        for ed in data.edges:
            db.add(WorkspaceEdge(
                workspace_id=workspace.id,
                edge_key=ed.edge_key,
                edge_type=ed.edge_type,
                source_key=ed.source_key,
                target_key=ed.target_key,
                data=ed.data,
            ))

    await db.commit()
    return await _reload(db, workspace_id)


async def delete_workspace(db: AsyncSession, workspace_id: int) -> bool:
    """Delete a workspace and all its nodes/edges. Returns True if deleted."""
    result = await db.execute(
        select(Workspace).where(Workspace.id == workspace_id)
    )
    workspace = result.scalar_one_or_none()
    if workspace is None:
        return False

    await db.delete(workspace)
    await db.commit()
    return True


# ── Helpers ──────────────────────────────────────────────


async def _reload(db: AsyncSession, workspace_id: int) -> Workspace:
    """Reload workspace with all relationships after a commit."""
    result = await db.execute(
        select(Workspace)
        .options(selectinload(Workspace.nodes), selectinload(Workspace.edges))
        .where(Workspace.id == workspace_id)
    )
    return result.scalar_one()
