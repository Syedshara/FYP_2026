"""
Simulation API — start / stop / monitor traffic replay simulations.

Simplified endpoints (auto replay‑speed, auto loop/shuffle):
  GET    /simulation/scenarios     — available scenario packs
  GET    /simulation/status        — current simulation state
  POST   /simulation/start         — start a simulation
  POST   /simulation/stop          — stop the running simulation
  GET    /simulation/containers    — live Docker container state
  GET    /simulation/clients       — list DB clients eligible for simulation
  POST   /simulation/attack-node/start  — start CVAE attack on target devices
  POST   /simulation/attack-node/stop   — stop attack‑node containers
  POST   /simulation/traffic-node/start — start CVAE benign traffic generation
  POST   /simulation/traffic-node/stop  — stop traffic‑node containers
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_db, get_current_user
from app.services import simulation_service, fl_service

log = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────

class SimStartRequest(BaseModel):
    """The only thing the user chooses: scenario, duration, and clients."""
    scenario: str = Field(
        default="client_data",
        description="Scenario name (e.g. 'ddos_attack') or 'client_data'",
    )
    duration: str = Field(
        default="continuous",
        description="Duration preset: '5min' | '30min' | 'continuous'",
    )
    clients: list[str] = Field(
        ...,
        min_length=1,
        description="List of client_id strings to run simulation for",
    )


class ScenarioOut(BaseModel):
    name: str
    description: str
    attack_labels: list[str] = []
    total_windows: int = 0
    attack_rate: float = 0.0
    flow_rate: float = 5.0
    is_default: bool = False


class SimStatusOut(BaseModel):
    state: str
    config: dict
    clients: list[dict]
    started_at: Optional[float] = None
    uptime_seconds: float = 0.0
    scenario_description: str = ""


class SimClientOut(BaseModel):
    """Lightweight client info for the simulation page."""
    id: int
    client_id: str
    name: str
    status: str
    total_samples: int = 0
    device_count: int = 0


class AttackNodeStartRequest(BaseModel):
    """Start CVAE attack generation targeting specific devices."""
    attack_node_id: str = Field(..., description="Canvas attack node ID")
    attack_category: str = Field(
        ...,
        description=(
            "Attack type: ddos | port-scan | botnet | mitm | "
            "replay | malformed | iot-protocol"
        ),
    )
    target_device_ids: list[str] = Field(
        ...,
        min_length=1,
        description="Device IDs to attack (resolved from canvas edges)",
    )
    intensity: float = Field(
        default=0.8,
        ge=0.0,
        le=1.0,
        description="Attack intensity 0.0‑1.0 → maps to CVAE attack_ratio",
    )


class AttackNodeStopRequest(BaseModel):
    """Stop a running attack‑node simulation."""
    attack_node_id: str = Field(..., description="Canvas attack node ID to stop")


class AttackNodeResponse(BaseModel):
    """Response after starting/stopping an attack‑node simulation."""
    run_id: str
    attack_node_id: str
    status: str
    container_names: list[str] = []
    class_id: Optional[int] = None
    class_name: Optional[str] = None
    attack_ratio: Optional[float] = None
    containers_stopped: Optional[int] = None


class TrafficNodeStartRequest(BaseModel):
    """Start CVAE benign traffic generation targeting specific devices."""
    traffic_node_id: str = Field(..., description="Canvas traffic source node ID")
    target_device_ids: list[str] = Field(
        ...,
        min_length=1,
        description="Device IDs to send benign traffic to",
    )
    flow_rate: float = Field(
        default=5.0,
        ge=0.5,
        le=100.0,
        description="Flows per second (controls generation speed)",
    )


class TrafficNodeStopRequest(BaseModel):
    """Stop a running traffic‑node simulation."""
    traffic_node_id: str = Field(..., description="Canvas traffic source node ID to stop")


class TrafficNodeResponse(BaseModel):
    """Response after starting/stopping a traffic‑node simulation."""
    run_id: str
    traffic_node_id: str
    status: str
    container_names: list[str] = []
    class_id: int = 0
    class_name: str = "benign"
    containers_stopped: Optional[int] = None


# ── Endpoints ────────────────────────────────────────────

@router.get("/scenarios", response_model=list[ScenarioOut])
async def list_scenarios(_user=Depends(get_current_user)):
    """List available traffic‑replay scenario packs."""
    return simulation_service.list_scenarios()


@router.get("/status", response_model=SimStatusOut)
async def get_status(_user=Depends(get_current_user)):
    """Current simulation state, config, and per‑client status."""
    return simulation_service.get_status().to_dict()


@router.get("/clients", response_model=list[SimClientOut])
async def list_sim_clients(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    List all registered FL clients that can participate in a simulation.

    Returns lightweight records with device counts so the UI can show
    which clients have devices and which will get virtual ones.
    """
    from app.services import device_service

    clients = await fl_service.get_all_fl_clients(db)
    out: list[dict] = []
    for c in clients:
        devices = await device_service.get_all_devices(db, client_id=c.id)
        out.append({
            "id": c.id,
            "client_id": c.client_id,
            "name": c.name,
            "status": c.status,
            "total_samples": c.total_samples,
            "device_count": len(devices),
        })
    return out


@router.post("/start", response_model=SimStatusOut)
async def start_simulation(
    req: SimStartRequest,
    _user=Depends(get_current_user),
):
    """
    Start a traffic replay simulation.

    The backend auto‑configures replay speed, loop, and shuffle based on
    the chosen scenario.  The user only picks scenario + duration + clients.
    """
    try:
        status = await simulation_service.start_simulation(
            scenario=req.scenario,
            duration=req.duration,
            client_ids=req.clients,
        )
        return status.to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to start simulation: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to start simulation: {exc}")


@router.post("/stop", response_model=SimStatusOut)
async def stop_simulation(_user=Depends(get_current_user)):
    """Stop the running simulation and remove containers."""
    try:
        status = await simulation_service.stop_simulation()
        return status.to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to stop simulation: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to stop simulation: {exc}")


@router.get("/containers")
async def get_container_status(_user=Depends(get_current_user)):
    """Live Docker container state for every sim client."""
    try:
        return await simulation_service.get_container_statuses()
    except Exception as exc:
        log.error("Container status error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ── Attack‑Node Endpoints ────────────────────────────────

@router.post("/attack-node/start", response_model=AttackNodeResponse)
async def start_attack_node(
    req: AttackNodeStartRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Start CVAE attack generation for an attack node.

    Spawns one container per target device running the CVAE decoder
    with the mapped class_id.  Runs indefinitely until stopped.
    """
    try:
        result = await simulation_service.start_attack_node_sim(
            attack_node_id=req.attack_node_id,
            attack_category=req.attack_category,
            target_device_ids=req.target_device_ids,
            db=db,
            intensity=req.intensity,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to start attack-node sim: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start attack simulation: {exc}",
        )


@router.post("/attack-node/stop", response_model=AttackNodeResponse)
async def stop_attack_node(
    req: AttackNodeStopRequest,
    _user=Depends(get_current_user),
):
    """Stop all containers for an attack node."""
    try:
        result = await simulation_service.stop_attack_node_sim(
            attack_node_id=req.attack_node_id,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to stop attack-node sim: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to stop attack simulation: {exc}",
        )


# ── Traffic‑Node Endpoints ──────────────────────────────

@router.post("/traffic-node/start", response_model=TrafficNodeResponse)
async def start_traffic_node(
    req: TrafficNodeStartRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Start CVAE benign traffic generation for a traffic source node.

    Spawns one container per target device running the CVAE decoder
    with class_id=0 (benign).  Runs indefinitely until stopped.
    """
    try:
        result = await simulation_service.start_traffic_node_sim(
            traffic_node_id=req.traffic_node_id,
            target_device_ids=req.target_device_ids,
            db=db,
            flow_rate=req.flow_rate,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to start traffic-node sim: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start traffic simulation: {exc}",
        )


@router.post("/traffic-node/stop", response_model=TrafficNodeResponse)
async def stop_traffic_node(
    req: TrafficNodeStopRequest,
    _user=Depends(get_current_user),
):
    """Stop all containers for a traffic source node."""
    try:
        result = await simulation_service.stop_traffic_node_sim(
            traffic_node_id=req.traffic_node_id,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to stop traffic-node sim: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to stop traffic simulation: {exc}",
        )
