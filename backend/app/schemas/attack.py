"""
Pydantic schemas for Attack engine endpoints.

Supports attack template CRUD and execution run management.
"""

from datetime import datetime
from typing import Any, Optional, List

from pydantic import BaseModel, Field


# ── Attack Template ──────────────────────────────────────


class AttackCreate(BaseModel):
    name: str = Field(..., max_length=120)
    description: Optional[str] = None
    category: str = Field(
        ...,
        description="ddos | mitm | port-scan | replay | malformed | botnet | iot-protocol",
    )
    sub_type: str = Field(..., max_length=80, description="e.g. syn_flood, arp_spoof, mqtt_publish")
    target_ip: Optional[str] = Field(None, max_length=45)
    target_port: Optional[int] = None
    params: dict[str, Any] = Field(default_factory=dict)


class AttackUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=120)
    description: Optional[str] = None
    category: Optional[str] = None
    sub_type: Optional[str] = Field(None, max_length=80)
    target_ip: Optional[str] = Field(None, max_length=45)
    target_port: Optional[int] = None
    params: Optional[dict[str, Any]] = None


class AttackOut(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    category: str
    sub_type: str
    target_ip: Optional[str] = None
    target_port: Optional[int] = None
    params: dict[str, Any]
    user_id: str  # UUID as string
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AttackBrief(BaseModel):
    """Lightweight listing — no params blob."""
    id: int
    name: str
    category: str
    sub_type: str
    target_ip: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Attack Run ───────────────────────────────────────────


class AttackRunRequest(BaseModel):
    """Request to execute an attack."""
    duration_seconds: float = Field(default=30.0, ge=1.0, le=300.0, description="How long to run the attack (1-300s)")
    intensity: str = Field(default="medium", description="low | medium | high")
    target_ip_override: Optional[str] = Field(None, description="Override target IP from template")
    target_port_override: Optional[int] = Field(None, description="Override target port from template")


class AttackRunOut(BaseModel):
    id: int
    attack_id: int
    status: str
    container_id: Optional[str] = None
    container_name: Optional[str] = None
    duration_seconds: Optional[float] = None
    packets_sent: Optional[int] = None
    packets_captured: Optional[int] = None
    detections: Optional[int] = None
    detection_rate: Optional[float] = None
    results: dict[str, Any]
    error_message: Optional[str] = None
    started_at: datetime
    finished_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class AttackRunBrief(BaseModel):
    id: int
    attack_id: int
    status: str
    packets_sent: Optional[int] = None
    detections: Optional[int] = None
    detection_rate: Optional[float] = None
    started_at: datetime
    finished_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ── Attack Catalog (for the palette/dropdown) ───────────


class AttackVariant(BaseModel):
    """A specific attack variant within a category."""
    sub_type: str
    label: str
    description: str
    default_params: dict[str, Any] = Field(default_factory=dict)


class AttackCatalog(BaseModel):
    """Full catalog of available attack types and variants."""
    categories: dict[str, List[AttackVariant]]
