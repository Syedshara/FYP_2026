"""
Pydantic schemas for Device endpoints.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class DeviceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    device_type: str = Field(default="sensor")
    ip_address: Optional[str] = None
    protocol: str = Field(default="tcp")
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    traffic_source: str = Field(default="simulated")
    description: Optional[str] = None
    client_id: Optional[int] = Field(default=None, description="FK to FL client that owns this device")


class DeviceUpdate(BaseModel):
    name: Optional[str] = None
    device_type: Optional[str] = None
    ip_address: Optional[str] = None
    protocol: Optional[str] = None
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    status: Optional[str] = None
    traffic_source: Optional[str] = None
    description: Optional[str] = None
    client_id: Optional[int] = None


class DeviceOut(BaseModel):
    id: UUID
    name: str
    device_type: str
    ip_address: Optional[str]
    protocol: str
    port: Optional[int]
    status: str
    traffic_source: str
    description: Optional[str]
    client_id: Optional[int] = None
    last_seen_at: Optional[datetime]
    threat_count_today: int
    created_at: datetime
    updated_at: Optional[datetime]

    model_config = {"from_attributes": True}


class DeviceBrief(BaseModel):
    """Minimal device info for nesting inside client responses."""
    id: UUID
    name: str
    device_type: str
    status: str
    ip_address: Optional[str] = None

    model_config = {"from_attributes": True}
