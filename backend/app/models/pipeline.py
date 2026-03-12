"""
Pipeline + PipelineNode models.

A Pipeline is a saved node-canvas workflow.
Each PipelineNode stores its type, canvas position, config JSON,
and the edge list (denormalized for simplicity).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Integer, Float, String, Text, DateTime, JSON, ForeignKey
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Pipeline(Base):
    """
    Top-level pipeline record — one per saved canvas workflow.
    Owns an ordered list of PipelineNode rows.
    """
    __tablename__ = "pipelines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False, default="New Pipeline")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        SAEnum(
            "idle", "running", "error",
            name="pipeline_status_enum",
            create_constraint=True,
            create_type=False,
        ),
        nullable=False,
        default="idle",
    )
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
    nodes: Mapped[list["PipelineNode"]] = relationship(
        back_populates="pipeline",
        cascade="all, delete-orphan",
        order_by="PipelineNode.id",
    )


class PipelineNode(Base):
    """
    A single node on the pipeline canvas.

    node_type values:
      source_scenario  — replays a CIC-IDS2017 scenario pack
      attack_inject    — overlays an attack with configurable intensity + duration
      rate_filter      — throttles / samples the traffic stream
      monitor_sink     — final sink; streams predictions to TrafficMonitor

    config is a free-form JSON blob whose keys depend on node_type:
      source_scenario:  { scenario, flow_rate, loop }
      attack_inject:    { attack_type, intensity, duration_sec }
      rate_filter:      { max_flows_per_sec, sample_rate }
      monitor_sink:     {}

    edges_json stores the outgoing edges as a list of
      { "source_key": "<node_key>", "target_key": "<node_key>" }
    denormalised here for easy React Flow round-trip serialisation.
    """
    __tablename__ = "pipeline_nodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pipeline_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("pipelines.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Stable ID that React Flow assigns — used as the canvas node id
    node_key: Mapped[str] = mapped_column(String(50), nullable=False)

    node_type: Mapped[str] = mapped_column(
        SAEnum(
            "source_scenario",
            "attack_inject",
            "rate_filter",
            "monitor_sink",
            name="pipeline_node_type_enum",
            create_constraint=True,
            create_type=False,
        ),
        nullable=False,
    )

    label: Mapped[str] = mapped_column(String(100), nullable=False, default="")

    # Node-specific configuration
    config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)

    # Canvas position (stored so the layout survives page reloads)
    position_x: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    position_y: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    # Outgoing edges from this node: [{"source_key": "...", "target_key": "..."}]
    edges_json: Mapped[list[dict[str, str]]] = mapped_column(
        JSON, nullable=False, default=list
    )

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
    pipeline: Mapped["Pipeline"] = relationship(back_populates="nodes")
