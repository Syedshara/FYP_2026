"""
Device management API endpoints.
"""

from typing import Optional
from uuid import UUID
from datetime import datetime

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_db, get_current_user
from app.models.user import User
from app.services import device_service

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────

class DeviceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    device_type: str = Field(default="sensor")
    ip_address: Optional[str] = Field(default=None, max_length=45)
    protocol: str = Field(default="tcp")
    port: int = Field(default=0, ge=0, le=65535)
    traffic_source: str = Field(default="simulated")
    description: Optional[str] = None
    client_id: Optional[int] = Field(default=None, description="FK to FL client")


class DeviceUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    device_type: Optional[str] = None
    ip_address: Optional[str] = Field(default=None, max_length=45)
    protocol: Optional[str] = None
    port: Optional[int] = Field(default=None, ge=0, le=65535)
    status: Optional[str] = None
    traffic_source: Optional[str] = None
    description: Optional[str] = None
    client_id: Optional[int] = None


class DeviceOut(BaseModel):
    id: UUID
    name: str
    device_type: str
    ip_address: Optional[str] = None
    protocol: str
    port: int
    status: str
    traffic_source: str
    description: Optional[str] = None
    client_id: Optional[int] = None
    last_seen_at: Optional[datetime] = None
    threat_count_today: int = 0
    created_at: datetime
    updated_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


# ── Endpoints ────────────────────────────────────────────

@router.get("/", response_model=list[DeviceOut])
async def list_devices(
    client_id: Optional[int] = Query(default=None, description="Filter devices by FL client ID"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """List all devices, optionally filtered by client_id."""
    return await device_service.get_all_devices(db, client_id=client_id)


@router.post("/", response_model=DeviceOut, status_code=status.HTTP_201_CREATED)
async def create_device(
    body: DeviceCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Register a new device."""
    return await device_service.create_device(
        db,
        name=body.name,
        device_type=body.device_type,
        ip_address=body.ip_address,
        protocol=body.protocol,
        port=body.port,
        traffic_source=body.traffic_source,
        description=body.description,
        client_id=body.client_id,
    )


@router.get("/{device_id}", response_model=DeviceOut)
async def get_device(
    device_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Get a device by ID."""
    return await device_service.get_device(db, device_id)


@router.patch("/{device_id}", response_model=DeviceOut)
async def update_device(
    device_id: UUID,
    body: DeviceUpdate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Update a device."""
    return await device_service.update_device(
        db,
        device_id,
        **body.model_dump(exclude_unset=True),
    )


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(
    device_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Delete a device."""
    await device_service.delete_device(db, device_id)
