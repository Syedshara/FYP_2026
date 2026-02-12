"""
Simulation API — control traffic replay simulations.

Endpoints:
  GET    /simulation/scenarios          — list available scenario packs
  GET    /simulation/status             — current simulation state
  POST   /simulation/start              — start a simulation
  POST   /simulation/stop               — stop the running simulation
  GET    /simulation/containers         — real-time container status
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import simulation_service
from app.services.simulation_service import SimulationConfig

log = logging.getLogger(__name__)

router = APIRouter()


# ── Request / Response schemas ───────────────────────────

class SimulationStartRequest(BaseModel):
    """Request body to start a simulation."""
    scenario: str = Field(
        default="",
        description="Scenario name (empty or 'client_data' for default client data)",
    )
    replay_speed: float = Field(
        default=1.0, ge=0.1, le=10.0,
        description="Replay speed multiplier (0.1–10.0)",
    )
    monitor_interval: float = Field(
        default=3.0, ge=0.5, le=30.0,
        description="Seconds between prediction cycles",
    )
    replay_loop: bool = Field(
        default=True,
        description="Loop replay when data is exhausted",
    )
    replay_shuffle: bool = Field(
        default=False,
        description="Shuffle window order (breaks temporal ordering)",
    )
    clients: list[str] = Field(
        default=["bank_a", "bank_b", "bank_c"],
        description="List of client IDs to run simulation for",
    )
    selected_client_id: Optional[str] = Field(
        default=None,
        description="Specific client ID to simulate (overrides clients list)",
    )
    selected_device_id: Optional[str] = Field(
        default=None,
        description="Specific device ID to simulate traffic for",
    )
    attack_ratio: float = Field(
        default=0.2, ge=0.0, le=1.0,
        description="Fraction of traffic that should be attacks (0.0–1.0)",
    )
    attack_type: Optional[str] = Field(
        default=None,
        description="Optional: force a specific attack type (ddos|portscan|slowloris|infiltration)",
    )


class ScenarioOut(BaseModel):
    name: str
    description: str
    attack_labels: list[str] = []
    total_windows: int = 0
    attack_rate: float = 0.0
    is_default: bool = False


class SimulationStatusOut(BaseModel):
    state: str
    config: dict
    clients: list[dict]
    started_at: Optional[float] = None
    uptime_seconds: float = 0.0


# ── Endpoints ────────────────────────────────────────────

@router.get("/scenarios", response_model=list[ScenarioOut])
async def list_scenarios():
    """
    List all available traffic replay scenarios.

    Includes the default 'client_data' option plus any pre-built
    scenario packs from data/scenarios/.
    """
    return simulation_service.list_scenarios()


@router.get("/status", response_model=SimulationStatusOut)
async def get_status():
    """Get current simulation status, config, and per-client state."""
    status = simulation_service.get_status()
    return status.to_dict()


@router.post("/start", response_model=SimulationStatusOut)
async def start_simulation(req: SimulationStartRequest):
    """
    Start a traffic replay simulation.

    Creates FL client containers in MONITOR mode, replaying real
    CIC-IDS2017 data through the trained CNN-LSTM model.
    
    If selected_client_id is provided, uses that client instead of the clients list.
    If selected_device_id is provided, passes it to the client for device-specific monitoring.
    """
    # If specific client is selected, use only that client
    clients_to_simulate = [req.selected_client_id] if req.selected_client_id else req.clients
    
    config = SimulationConfig(
        scenario=req.scenario if req.scenario != "client_data" else "",
        replay_speed=req.replay_speed,
        monitor_interval=req.monitor_interval,
        replay_loop=req.replay_loop,
        replay_shuffle=req.replay_shuffle,
        clients=clients_to_simulate,
        selected_client_id=req.selected_client_id,
        selected_device_id=req.selected_device_id,
        attack_ratio=req.attack_ratio,
        selected_attack_type=req.attack_type,
    )

    try:
        status = await simulation_service.start_simulation(config)
        return status.to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to start simulation: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to start simulation: {exc}")


@router.post("/stop", response_model=SimulationStatusOut)
async def stop_simulation():
    """Stop the running simulation and remove containers."""
    try:
        status = await simulation_service.stop_simulation()
        return status.to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.error("Failed to stop simulation: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to stop simulation: {exc}")


@router.get("/containers")
async def get_container_status():
    """
    Get real-time Docker container status for all simulation clients.

    This queries the Docker daemon directly for live container state.
    """
    try:
        return await simulation_service.get_client_container_status()
    except Exception as exc:
        log.error("Failed to get container status: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
