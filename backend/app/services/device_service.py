"""
Device CRUD service.
"""

from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.device import Device
from app.core.exceptions import NotFoundException, ConflictException


async def create_device(
    db: AsyncSession,
    name: str,
    device_type: str = "sensor",
    ip_address: Optional[str] = None,
    protocol: str = "tcp",
    port: int = 0,
    traffic_source: str = "simulated",
    description: Optional[str] = None,
) -> Device:
    """Create a new device."""
    # Check for duplicate name
    existing = await db.execute(
        select(Device).where(Device.name == name)
    )
    if existing.scalar_one_or_none():
        raise ConflictException(f"Device with name '{name}' already exists")

    device = Device(
        name=name,
        device_type=device_type,
        ip_address=ip_address,
        protocol=protocol,
        port=port,
        traffic_source=traffic_source,
        description=description,
    )
    db.add(device)
    await db.commit()
    await db.refresh(device)
    return device


async def get_device(db: AsyncSession, device_id: UUID) -> Device:
    """Get a device by ID."""
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise NotFoundException("Device not found")
    return device


async def get_all_devices(db: AsyncSession) -> list[Device]:
    """List all devices."""
    result = await db.execute(select(Device).order_by(Device.created_at.desc()))
    return list(result.scalars().all())


async def update_device(
    db: AsyncSession,
    device_id: UUID,
    **kwargs,
) -> Device:
    """Update device fields."""
    device = await get_device(db, device_id)
    for key, value in kwargs.items():
        if value is not None and hasattr(device, key):
            setattr(device, key, value)
    await db.commit()
    await db.refresh(device)
    return device


async def delete_device(db: AsyncSession, device_id: UUID) -> None:
    """Delete a device."""
    device = await get_device(db, device_id)
    await db.delete(device)
    await db.commit()
