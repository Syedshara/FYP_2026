"""
Pydantic schemas for Federated Learning endpoints.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ── FL Round ────────────────────────────────────────────

class FLRoundOut(BaseModel):
    id: UUID
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
    created_at: datetime

    model_config = {"from_attributes": True}


# ── FL Client ──────────────────────────────────────────

class FLClientCreate(BaseModel):
    client_id: str = Field(..., min_length=1, max_length=100)
    data_path: Optional[str] = None


class FLClientOut(BaseModel):
    id: UUID
    client_id: str
    status: str
    data_path: Optional[str]
    container_id: Optional[str]
    last_seen_at: Optional[datetime]
    created_at: datetime

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
