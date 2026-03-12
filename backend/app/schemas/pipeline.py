"""
Pydantic schemas for Pipeline endpoints.
"""

from datetime import datetime
from typing import Any, Optional, List

from pydantic import BaseModel, Field


# ── Pipeline Node ─────────────────────────────────────────


class PipelineNodeCreate(BaseModel):
    node_key: str = Field(..., max_length=50, description="Stable React Flow node id")
    node_type: str = Field(
        ...,
        description="source_scenario | attack_inject | rate_filter | monitor_sink",
    )
    label: str = Field(default="", max_length=100)
    config: dict[str, Any] = Field(default_factory=dict)
    position_x: float = Field(default=0.0)
    position_y: float = Field(default=0.0)
    edges_json: List[dict[str, str]] = Field(
        default_factory=list,
        description='Outgoing edges: [{"source_key": "...", "target_key": "..."}]',
    )


class PipelineNodeUpdate(BaseModel):
    label: Optional[str] = Field(default=None, max_length=100)
    config: Optional[dict[str, Any]] = None
    position_x: Optional[float] = None
    position_y: Optional[float] = None
    edges_json: Optional[List[dict[str, str]]] = None


class PipelineNodeOut(BaseModel):
    id: int
    pipeline_id: int
    node_key: str
    node_type: str
    label: str
    config: dict[str, Any]
    position_x: float
    position_y: float
    edges_json: List[dict[str, str]]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Pipeline ─────────────────────────────────────────────


class PipelineCreate(BaseModel):
    name: str = Field(default="New Pipeline", max_length=100)
    description: Optional[str] = None
    nodes: List[PipelineNodeCreate] = Field(default_factory=list)


class PipelineUpdate(BaseModel):
    """
    Full canvas save — replaces the pipeline name/desc and
    the entire node list in one atomic write.
    """
    name: Optional[str] = Field(default=None, max_length=100)
    description: Optional[str] = None
    nodes: Optional[List[PipelineNodeCreate]] = None


class PipelineOut(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    status: str
    created_at: datetime
    updated_at: datetime
    nodes: List[PipelineNodeOut] = []

    model_config = {"from_attributes": True}


class PipelineBrief(BaseModel):
    """Lightweight listing — no nodes."""
    id: int
    name: str
    description: Optional[str] = None
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Execution control ────────────────────────────────────


class PipelineStatusOut(BaseModel):
    """Live execution status returned by GET /pipelines/{id}/status."""
    pipeline_id: int
    status: str          # idle | running | error
    active_clients: List[str] = []
    scenario: Optional[str] = None
    uptime_seconds: Optional[float] = None
    error_message: Optional[str] = None
