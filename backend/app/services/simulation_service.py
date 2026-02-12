"""
Simulation service — manages traffic replay simulations.

Controls FL client containers running in MONITOR mode with real CIC-IDS2017
data replay via ReplaySimulator.

Key capabilities:
  - Start/stop simulation for specific clients or all clients
  - Select scenario (ddos, portscan, etc.) or use client data
  - Configure replay speed and other parameters
  - Track simulation state and broadcast via WebSocket
  - Discover available scenario packs
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Optional

from app.config import settings

log = logging.getLogger(__name__)

# ── Scenario discovery ───────────────────────────────────

# Inside the backend container, scenario data is at /app/client_data/../scenarios
# But on the host, it's at <PROJECT_ROOT>/data/scenarios
SCENARIO_HOST_DIR = os.path.join(settings.HOST_PROJECT_ROOT, "data", "scenarios")
# Inside backend container: the data dir is mounted at /app/client_data
# Scenarios are alongside client data at the project level
SCENARIO_CONTAINER_DIR = "/app/scenarios"

# For reading scenario metadata inside the backend container,
# we check the host-level path mapped via docker volume
# The backend has ./data/clients:/app/client_data:rw
# We need to also read scenarios - let's use a path relative to client_data
_SCENARIO_BASE = Path("/app/client_data").parent / "scenarios"
# Fallback: try to read from host path if we're running outside Docker
_SCENARIO_PATHS = [
    Path("/app/scenarios"),
    _SCENARIO_BASE,
    Path(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                       "data", "scenarios")),
]


def _find_scenario_dir() -> Optional[Path]:
    """Find the scenario directory inside the container or on the host."""
    for p in _SCENARIO_PATHS:
        if p.exists() and p.is_dir():
            return p
    return None


class SimulationState(str, Enum):
    IDLE = "idle"
    STARTING = "starting"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPING = "stopping"
    ERROR = "error"


@dataclass
class SimulationConfig:
    """Configuration for a simulation run."""
    scenario: str = ""                # empty = use client data
    replay_speed: float = 1.0        # multiplier (0.5 = half speed, 2.0 = double)
    monitor_interval: float = 3.0    # seconds between cycles
    replay_loop: bool = True         # loop when exhausted
    replay_shuffle: bool = False     # shuffle window order
    clients: list[str] = field(default_factory=lambda: ["bank_a", "bank_b", "bank_c"])
    selected_client_id: Optional[str] = None  # Specific client to simulate
    selected_device_id: Optional[str] = None  # Specific device to simulate
    attack_ratio: float = 0.2        # Fraction of traffic that is attacks
    selected_attack_type: Optional[str] = None  # Force a specific attack type (e.g. 'ddos')


@dataclass
class ClientSimStatus:
    """Status of one client's simulation."""
    client_id: str
    container_id: Optional[str] = None
    container_name: Optional[str] = None
    state: SimulationState = SimulationState.IDLE
    started_at: Optional[float] = None
    error: Optional[str] = None


@dataclass
class SimulationStatus:
    """Overall simulation status."""
    state: SimulationState = SimulationState.IDLE
    config: SimulationConfig = field(default_factory=SimulationConfig)
    clients: list[ClientSimStatus] = field(default_factory=list)
    started_at: Optional[float] = None
    uptime_seconds: float = 0.0

    def to_dict(self) -> dict:
        d = {
            "state": self.state.value,
            "config": asdict(self.config),
            "clients": [asdict(c) for c in self.clients],
            "started_at": self.started_at,
            "uptime_seconds": round(self.uptime_seconds, 1),
        }
        # Convert enum values to strings
        for c in d["clients"]:
            c["state"] = c["state"].value if hasattr(c["state"], "value") else c["state"]
        return d


# ── Singleton state ──────────────────────────────────────
_simulation_status = SimulationStatus()


def get_status() -> SimulationStatus:
    """Get current simulation status."""
    if _simulation_status.started_at and _simulation_status.state == SimulationState.RUNNING:
        _simulation_status.uptime_seconds = time.time() - _simulation_status.started_at
    return _simulation_status


# ── Scenario Discovery ───────────────────────────────────

def list_scenarios() -> list[dict]:
    """
    Discover available scenario packs from the filesystem.

    Returns list of metadata dicts for each scenario.
    """
    scenarios = []

    # Always include "client_data" as a virtual scenario
    scenarios.append({
        "name": "client_data",
        "description": "Use each client's own training data partition (default)",
        "attack_labels": ["mixed"],
        "total_windows": 0,
        "attack_rate": 0,
        "is_default": True,
    })

    scenario_dir = _find_scenario_dir()
    if scenario_dir is None:
        log.warning("No scenario directory found — only client_data available")
        return scenarios

    for entry in sorted(scenario_dir.iterdir()):
        if not entry.is_dir():
            continue
        meta_path = entry / "metadata.json"
        if meta_path.exists():
            try:
                with open(meta_path, "r") as f:
                    meta = json.load(f)
                meta["is_default"] = False
                scenarios.append(meta)
            except Exception as exc:
                log.warning("Failed to read metadata for %s: %s", entry.name, exc)
                scenarios.append({
                    "name": entry.name,
                    "description": f"Scenario: {entry.name}",
                    "total_windows": 0,
                    "attack_rate": 0,
                    "is_default": False,
                })
        else:
            # Check if X.npy exists at least
            if (entry / "X.npy").exists():
                scenarios.append({
                    "name": entry.name,
                    "description": f"Scenario: {entry.name}",
                    "total_windows": 0,
                    "attack_rate": 0,
                    "is_default": False,
                })

    return scenarios


# ── Simulation Control ───────────────────────────────────

async def start_simulation(config: SimulationConfig) -> SimulationStatus:
    """
    Start traffic simulation for specified clients.

    If FL client containers are available, creates/starts them in MONITOR mode.
    Otherwise, falls back to synthetic traffic generation in the backend.
    """
    global _simulation_status

    from app.services import docker_service
    from app.core.websocket import ws_manager, WSMessageType, build_ws_message

    if _simulation_status.state == SimulationState.RUNNING:
        raise ValueError("Simulation already running. Stop it first.")

    _simulation_status.state = SimulationState.STARTING
    _simulation_status.config = config
    _simulation_status.clients = []
    _simulation_status.started_at = time.time()

    log.info("Starting simulation: scenario=%s, speed=%.1f, clients=%s",
             config.scenario or "client_data", config.replay_speed, config.clients)

    # Check if FL client containers are available
    containers_available = docker_service.image_exists(docker_service.FL_CLIENT_IMAGE)
    if not containers_available:
        log.info("FL client image not found. Using backend synthetic traffic mode.")
        
        from app.services import synthetic_simulation
        
        # Start synthetic traffic generation
        try:
            await synthetic_simulation.start_synthetic_simulation(
                backend_db=None,  # Not needed for synthetic mode
                monitor_interval=config.monitor_interval,
                attack_ratio=config.attack_ratio,
                window_size=10,
                device_id=config.selected_device_id,
                client_id=config.selected_client_id,
                selected_attack_type=config.selected_attack_type,
            )
            log.info("Synthetic simulation started with attack_ratio=%.2f, device_id=%s",
                     config.attack_ratio, config.selected_device_id)
        except Exception as exc:
            log.error("Failed to start synthetic simulation: %s", exc, exc_info=True)
            _simulation_status.state = SimulationState.ERROR
            await ws_manager.broadcast(build_ws_message(
                WSMessageType.SIMULATION_STATUS,
                {"state": "error", "error": str(exc)},
            ))
            return _simulation_status
        
        _simulation_status.state = SimulationState.RUNNING
        _simulation_status.started_at = time.time()
        # Create virtual client entries for tracking
        for client_id in config.clients:
            _simulation_status.clients.append(
                ClientSimStatus(
                    client_id=client_id,
                    state=SimulationState.RUNNING,
                    started_at=time.time(),
                )
            )
        await ws_manager.broadcast(build_ws_message(
            WSMessageType.SIMULATION_STATUS,
            get_status().to_dict(),
        ))
        return _simulation_status

    # Broadcast starting status
    await ws_manager.broadcast(build_ws_message(
        WSMessageType.SIMULATION_STATUS,
        {"state": "starting", "scenario": config.scenario or "client_data"},
    ))

    host_root = settings.HOST_PROJECT_ROOT

    for client_id in config.clients:
        client_status = ClientSimStatus(client_id=client_id)
        try:
            # Build environment with simulation config
            environment = {
                "CLIENT_ID": client_id,
                "FL_SERVER_URL": f"{docker_service.FL_SERVER_CONTAINER}:{settings.FL_SERVER_PORT}",
                "DATA_PATH": "/app/data",
                "BACKEND_URL": "http://iot_ids_backend:8000",
                "MODE": "MONITOR",
                "MONITOR_INTERVAL": str(config.monitor_interval),
                "REPLAY_SPEED": str(config.replay_speed),
                "REPLAY_LOOP": "true" if config.replay_loop else "false",
                "REPLAY_SHUFFLE": "true" if config.replay_shuffle else "false",
                "ATTACK_RATIO": str(config.attack_ratio),
            }

            # Add device ID if specified (for device-specific monitoring)
            if config.selected_device_id:
                environment["MONITOR_DEVICE_ID"] = config.selected_device_id

            # Add scenario env if specified
            if config.scenario and config.scenario != "client_data":
                environment["SCENARIO"] = config.scenario
                environment["SCENARIO_DIR"] = "/app/scenarios"

            # Build volume mounts
            host_data_dir = os.path.join(host_root, "data", "clients", client_id.lower())
            host_fl_common = os.path.join(host_root, "fl_common")
            host_fl_client = os.path.join(host_root, "fl_client")
            host_model = os.path.join(host_root, "model")
            host_scenarios = os.path.join(host_root, "data", "scenarios")

            volumes = {
                host_fl_client: {"bind": "/app", "mode": "rw"},
                host_fl_common: {"bind": "/fl_common", "mode": "rw"},
                host_data_dir:  {"bind": "/app/data", "mode": "ro"},
                host_model:     {"bind": "/app/models", "mode": "ro"},
            }

            # Mount scenarios directory if available
            if os.path.isdir(host_scenarios) or config.scenario:
                volumes[host_scenarios] = {"bind": "/app/scenarios", "mode": "ro"}

            container_name = f"iot_ids_sim_{client_id.lower()}"

            # Remove stale container
            docker_service._remove_if_exists(container_name)

            try:
                dk = docker_service._get_docker()
                container = dk.containers.create(
                    image=docker_service.FL_CLIENT_IMAGE,
                    name=container_name,
                    environment=environment,
                    volumes=volumes,
                    network=docker_service.DOCKER_NETWORK,
                    restart_policy={"Name": "no"},
                    detach=True,
                )

                container.start()
                container.reload()

                client_status.container_id = container.id
                client_status.container_name = container.name
                client_status.state = SimulationState.RUNNING
                client_status.started_at = time.time()

                log.info("Started simulation container %s for %s", container.name, client_id)
            except docker_service.ImageNotFound:
                # Should not reach here due to early check, but handle gracefully
                raise ValueError(f"Docker image {docker_service.FL_CLIENT_IMAGE} not found. Ensure FL profile is enabled: docker-compose --profile fl up -d")
            except Exception as inner_exc:
                raise inner_exc

        except Exception as exc:
            log.error("Failed to start simulation for %s: %s", client_id, exc)
            client_status.state = SimulationState.ERROR
            client_status.error = str(exc)

        _simulation_status.clients.append(client_status)

    # Check if at least one client started successfully
    running = [c for c in _simulation_status.clients if c.state == SimulationState.RUNNING]
    if running:
        _simulation_status.state = SimulationState.RUNNING
    else:
        _simulation_status.state = SimulationState.ERROR

    # Broadcast running status
    await ws_manager.broadcast(build_ws_message(
        WSMessageType.SIMULATION_STATUS,
        get_status().to_dict(),
    ))

    return _simulation_status


async def stop_simulation() -> SimulationStatus:
    """Stop all running simulation containers and synthetic traffic."""
    global _simulation_status

    from app.services import docker_service, synthetic_simulation
    from app.core.websocket import ws_manager, WSMessageType, build_ws_message

    if _simulation_status.state not in (SimulationState.RUNNING, SimulationState.PAUSED, SimulationState.ERROR):
        raise ValueError(f"No simulation to stop (state={_simulation_status.state.value})")

    _simulation_status.state = SimulationState.STOPPING

    # Stop synthetic simulation if running
    if synthetic_simulation.is_synthetic_running():
        try:
            await synthetic_simulation.stop_synthetic_simulation()
            log.info("Stopped synthetic simulation")
        except Exception as exc:
            log.warning("Error stopping synthetic simulation: %s", exc)

    for client_status in _simulation_status.clients:
        if client_status.container_id:
            try:
                docker_service.stop_container(client_status.container_id)
                docker_service.remove_container(client_status.container_id)
                log.info("Stopped simulation container %s", client_status.container_name)
            except Exception as exc:
                log.warning("Failed to stop container %s: %s", client_status.container_name, exc)

        client_status.state = SimulationState.IDLE
        client_status.container_id = None
        client_status.container_name = None

    _simulation_status.state = SimulationState.IDLE
    _simulation_status.uptime_seconds = 0.0
    _simulation_status.started_at = None

    # Broadcast stopped
    await ws_manager.broadcast(build_ws_message(
        WSMessageType.SIMULATION_STATUS,
        get_status().to_dict(),
    ))

    return _simulation_status


async def get_client_container_status() -> list[dict]:
    """Get real-time Docker status for simulation containers."""
    from app.services import docker_service

    results = []
    for client_status in _simulation_status.clients:
        info = {"client_id": client_status.client_id, "state": client_status.state.value}

        if client_status.container_id:
            container_info = docker_service.get_container_status(client_status.container_id)
            if container_info:
                info["container_status"] = container_info.status
                info["container_name"] = container_info.name
            else:
                info["container_status"] = "not_found"
                # Update local state
                client_status.state = SimulationState.ERROR
                client_status.error = "Container not found"

        results.append(info)

    return results
