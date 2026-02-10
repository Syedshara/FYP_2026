"""
Pydantic schemas for Federated Learning endpoints.
"""

from datetime import datetime
from typing import Optional, List
from uuid import UUID

from pydantic import BaseModel, Field


# ── FL Round ────────────────────────────────────────────

class FLRoundOut(BaseModel):
    id: int
    round_number: int
    num_clients: int
    global_loss: Optional[float]
    global_accuracy: Optional[float]
    global_f1: Optional[float]
    global_precision: Optional[float]
    global_recall: Optional[float]
    aggregation_method: str
    he_scheme: Optional[str]
    duration_seconds: Optional[float]
    timestamp: datetime

    model_config = {"from_attributes": True}


# ── FL Client ──────────────────────────────────────────

class FLClientCreate(BaseModel):
    client_id: str = Field(..., min_length=1, max_length=50, description="Unique short ID, e.g. 'bank_a'")
    name: str = Field(..., min_length=1, max_length=100, description="Display name, e.g. 'Bank A'")
    description: Optional[str] = None
    ip_address: Optional[str] = Field(default=None, max_length=45)
    data_path: str = Field(default="/app/data", description="Path to client data directory")


class FLClientUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    description: Optional[str] = None
    ip_address: Optional[str] = Field(default=None, max_length=45)
    status: Optional[str] = None
    data_path: Optional[str] = None
    total_samples: Optional[int] = None


class FLClientOut(BaseModel):
    id: int
    client_id: str
    name: str
    description: Optional[str] = None
    ip_address: Optional[str] = None
    status: str
    data_path: str
    container_id: Optional[str] = None
    container_name: Optional[str] = None
    total_samples: int = 0
    last_seen_at: Optional[datetime] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class FLClientDetailOut(FLClientOut):
    """Full client detail including nested devices."""
    devices: List["DeviceBrief"] = []

    model_config = {"from_attributes": True}


# ── FL Training Request ────────────────────────────────

class FLTrainRequest(BaseModel):
    num_rounds: int = Field(default=5, ge=1, le=100)
    min_clients: int = Field(default=2, ge=1)
    use_he: bool = Field(default=True)


class FLStatusResponse(BaseModel):
    is_training: bool
    current_round: Optional[int] = None
    total_rounds: Optional[int] = None
    active_clients: int = 0


# Import at bottom to avoid circular reference in forward ref
from app.schemas.device import DeviceBrief  # noqa: E402, F401

# Rebuild model to resolve forward references
FLClientDetailOut.model_rebuild()
