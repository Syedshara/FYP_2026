"""
Workspace model — persists the unified canvas state.

A Workspace is a saved canvas layout (one per user, expandable to many).
Each WorkspaceNode stores its canvas type, position, and type-specific config JSON.
Each WorkspaceEdge stores source→target with a semantic edge type.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Integer, Float, String, Text, DateTime, JSON, ForeignKey
from sqlalchemy import Enum as SAEnum, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


# ── Enum values ──────────────────────────────────────────

_NODE_TYPES = (
    "client",
    "device",
    "fl-server",
    "attack",
    "traffic-source",
    "rate-filter",
    "monitor",
    "watcher",
)

_EDGE_TYPES = (
    "ownership",
    "fl-communication",
    "traffic-feed",
    "attack-vector",
    "observation",
    "watcher-link",
)


class Workspace(Base):
    """Top-level workspace record — one saved canvas layout."""

    __tablename__ = "workspaces"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(
        String(100), nullable=False, default="My Workspace"
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Owner (FK to users table)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Viewport state (restored on load)
    viewport_x: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    viewport_y: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    viewport_zoom: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    nodes: Mapped[list["WorkspaceNode"]] = relationship(
        back_populates="workspace",
        cascade="all, delete-orphan",
        order_by="WorkspaceNode.id",
    )
    edges: Mapped[list["WorkspaceEdge"]] = relationship(
        back_populates="workspace",
        cascade="all, delete-orphan",
        order_by="WorkspaceEdge.id",
    )


class WorkspaceNode(Base):
    """
    A single node on the workspace canvas.

    node_type: one of the 7 canvas node types (client, device, fl-server, etc.)
    node_key: stable React Flow node id (e.g. "client-abc123")
    data: free-form JSON blob containing the type-specific fields
          matching the frontend CanvasNodeData union
    """

    __tablename__ = "workspace_nodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Stable ID that React Flow assigns
    node_key: Mapped[str] = mapped_column(String(80), nullable=False)

    node_type: Mapped[str] = mapped_column(
        SAEnum(
            *_NODE_TYPES,
            name="workspace_node_type_enum",
            create_constraint=True,
            create_type=False,
        ),
        nullable=False,
    )

    # Canvas position
    position_x: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    position_y: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    # Type-specific data blob (matches frontend CanvasNodeData union)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    workspace: Mapped["Workspace"] = relationship(back_populates="nodes")


class WorkspaceEdge(Base):
    """
    An edge connecting two nodes on the workspace canvas.

    edge_key: stable React Flow edge id (e.g. "edge-abc123")
    edge_type: semantic type (ownership, fl-communication, etc.)
    source_key / target_key: reference WorkspaceNode.node_key values
    """

    __tablename__ = "workspace_edges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    edge_key: Mapped[str] = mapped_column(String(80), nullable=False)

    edge_type: Mapped[str] = mapped_column(
        SAEnum(
            *_EDGE_TYPES,
            name="workspace_edge_type_enum",
            create_constraint=True,
            create_type=False,
        ),
        nullable=False,
    )

    source_key: Mapped[str] = mapped_column(String(80), nullable=False)
    target_key: Mapped[str] = mapped_column(String(80), nullable=False)

    # Optional data blob for edge-specific state (e.g., animated, label)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    workspace: Mapped["Workspace"] = relationship(back_populates="edges")
