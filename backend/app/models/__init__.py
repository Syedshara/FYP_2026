"""
Import all models so Alembic and SQLAlchemy can discover them.
"""

from app.models.user import User
from app.models.device import Device
from app.models.prediction import Prediction
from app.models.fl import (
    FLRound,
    FLClientMetric,
    FLClient,
    SecurityEventLog,
    FedRecoveryRun,
)
from app.models.pipeline import Pipeline, PipelineNode
from app.models.workspace import Workspace, WorkspaceNode, WorkspaceEdge
from app.models.attack import Attack, AttackRun

__all__ = [
    "User",
    "Device",
    "Prediction",
    "FLRound",
    "FLClientMetric",
    "FLClient",
    "SecurityEventLog",
    "FedRecoveryRun",
    "Pipeline",
    "PipelineNode",
    "Workspace",
    "WorkspaceNode",
    "WorkspaceEdge",
    "Attack",
    "AttackRun",
]
