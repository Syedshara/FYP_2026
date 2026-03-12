"""
Pydantic schemas for Workspace endpoints.

Supports full canvas save/load: the frontend sends the entire
nodes + edges array on PUT, and the backend replaces atomically.
"""

from datetime import datetime
from typing import Any, Optional, List

from pydantic import BaseModel, Field


# ── Workspace Node ────────────────────────────────────────


class WorkspaceNodeCreate(BaseModel):
    node_key: str = Field(..., max_length=80, description="Stable React Flow node id")
    node_type: str = Field(
        ...,
        description="client | device | fl-server | attack | traffic-source | rate-filter | monitor",
    )
    position_x: float = Field(default=0.0)
    position_y: float = Field(default=0.0)
    data: dict[str, Any] = Field(default_factory=dict, description="Type-specific node data blob")


class WorkspaceNodeOut(BaseModel):
    id: int
    workspace_id: int
    node_key: str
    node_type: str
    position_x: float
    position_y: float
    data: dict[str, Any]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Workspace Edge ────────────────────────────────────────


class WorkspaceEdgeCreate(BaseModel):
    edge_key: str = Field(..., max_length=80, description="Stable React Flow edge id")
    edge_type: str = Field(
        ...,
        description="ownership | fl-communication | traffic-feed | attack-vector | observation",
    )
    source_key: str = Field(..., max_length=80)
    target_key: str = Field(..., max_length=80)
    data: dict[str, Any] = Field(default_factory=dict)


class WorkspaceEdgeOut(BaseModel):
    id: int
    workspace_id: int
    edge_key: str
    edge_type: str
    source_key: str
    target_key: str
    data: dict[str, Any]
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Workspace ─────────────────────────────────────────────


class ViewportState(BaseModel):
    x: float = 0.0
    y: float = 0.0
    zoom: float = 1.0


class WorkspaceCreate(BaseModel):
    name: str = Field(default="My Workspace", max_length=100)
    description: Optional[str] = None
    nodes: List[WorkspaceNodeCreate] = Field(default_factory=list)
    edges: List[WorkspaceEdgeCreate] = Field(default_factory=list)
    viewport: ViewportState = Field(default_factory=ViewportState)


class WorkspaceSave(BaseModel):
    """
    Full canvas save — atomically replaces name, nodes, edges, and viewport.
    All fields are optional so the frontend can do partial saves.
    """
    name: Optional[str] = Field(default=None, max_length=100)
    description: Optional[str] = None
    nodes: Optional[List[WorkspaceNodeCreate]] = None
    edges: Optional[List[WorkspaceEdgeCreate]] = None
    viewport: Optional[ViewportState] = None


class WorkspaceOut(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    viewport: ViewportState
    created_at: datetime
    updated_at: datetime
    nodes: List[WorkspaceNodeOut] = []
    edges: List[WorkspaceEdgeOut] = []

    model_config = {"from_attributes": True}


class WorkspaceBrief(BaseModel):
    """Lightweight listing — no nodes or edges."""
    id: int
    name: str
    description: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
