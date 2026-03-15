"""
Simulation service — manages traffic‑replay and CVAE attack‑node simulations.

Spins up *separate* Docker containers (named ``iot_ids_sim_<client>``) that run
the FL‑client image in **MONITOR** mode.  Each container loads the trained
CNN‑LSTM model, replays real CIC‑IDS2017 data (scenario or client partition),
runs inference, and POSTs predictions to the backend.

Attack‑node simulations (Phase 2) use the CVAE decoder to generate synthetic
attack traffic on‑the‑fly.  Each attack node spawns one container *per target
device*, running indefinitely until the user clicks stop.

Design decisions (from user review):
  • Replay speed is *automatic* per scenario — no manual knob.
  • Loop/shuffle are always on — hidden from the user.
  • Duration is chosen via a simple selector (5 min / 30 min / continuous).
  • FL‑training containers are *not* touched — separate sim containers.
  • Clients are loaded dynamically from the database.
  • Clients must have registered devices — no virtual device auto‑creation.
  • Synthetic traffic is generated on-the-fly matching real CIC-IDS2017 profiles.
  • Attack‑node containers use USE_CVAE=true + ATTACK_CLASS_ID for CVAE generation.
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
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings

log = logging.getLogger(__name__)

# ── Automatic flow‑rates per scenario (flows/sec) ───────
# The monitor interval = 1 / rate.  These were tuned so that the
# scenario "feels" realistic without flooding the DB.
SCENARIO_FLOW_RATES: dict[str, float] = {
    "ddos_attack":    100.0,
    "portscan":       10.0,
    "brute_force":    3.0,
    "web_attacks":    5.0,
    "infiltration":   1.0,
    "botnet":         1.5,
    "benign_only":    5.0,
    "mixed_traffic":  20.0,
    "high_intensity": 50.0,
    "client_data":    5.0,   # default for client‑data mode
}

# ── Scenario descriptions (user‑friendly) ───────────────
SCENARIO_FRIENDLY: dict[str, str] = {
    "ddos_attack":    "Distributed Denial‑of‑Service flood",
    "portscan":       "Network port scanning reconnaissance",
    "brute_force":    "SSH / FTP brute‑force login attempts",
    "web_attacks":    "SQL‑injection & XSS web exploits",
    "infiltration":   "Stealthy network infiltration",
    "botnet":         "Botnet command‑and‑control traffic",
    "benign_only":    "Normal traffic — no attacks (baseline)",
    "mixed_traffic":  "Mix of benign & several attack types",
    "high_intensity": "High‑volume multi‑vector attacks",
}

# Duration presets (seconds) — "continuous" → 0 (no time limit)
DURATION_PRESETS: dict[str, int] = {
    "5min":       5 * 60,
    "30min":      30 * 60,
    "continuous": 0,
}

# ── Scenario directory lookup ────────────────────────────
_SCENARIO_PATHS = [
    Path("/app/scenarios"),
    Path("/app/client_data").parent / "scenarios",
    Path(os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        "data", "scenarios",
    )),
]


def _find_scenario_dir() -> Optional[Path]:
    """Find the mounted scenario directory (container or host)."""
    for p in _SCENARIO_PATHS:
        if p.exists() and p.is_dir():
            return p
    return None


# ── State / Config dataclasses ───────────────────────────

class SimState(str, Enum):
    IDLE     = "idle"
    STARTING = "starting"
    RUNNING  = "running"
    STOPPING = "stopping"
    ERROR    = "error"


@dataclass
class SimConfig:
    """Immutable config snapshot of a running simulation."""
    scenario: str = ""
    duration: str = "continuous"       # "5min" | "30min" | "continuous"
    duration_seconds: int = 0          # resolved value (0 = unlimited)
    flow_rate: float = 5.0             # auto‑set from scenario
    monitor_interval: float = 1.0      # = 1/flow_rate (capped ≥0.2)
    clients: list[str] = field(default_factory=list)


@dataclass
class ClientSimStatus:
    """Per‑client container status."""
    client_id: str
    client_name: str = ""
    container_id: Optional[str] = None
    container_name: Optional[str] = None
    state: SimState = SimState.IDLE
    started_at: Optional[float] = None
    error: Optional[str] = None


@dataclass
class SimStatus:
    """Global simulation state — serialised to the frontend."""
    state: SimState = SimState.IDLE
    config: SimConfig = field(default_factory=SimConfig)
    clients: list[ClientSimStatus] = field(default_factory=list)
    started_at: Optional[float] = None
    uptime_seconds: float = 0.0
    scenario_description: str = ""

    def to_dict(self) -> dict:
        d = {
            "state": self.state.value,
            "config": asdict(self.config),
            "clients": [],
            "started_at": self.started_at,
            "uptime_seconds": round(self.uptime_seconds, 1),
            "scenario_description": self.scenario_description,
        }
        for c in self.clients:
            cd = asdict(c)
            cd["state"] = cd["state"].value if hasattr(cd["state"], "value") else cd["state"]
            d["clients"].append(cd)
        return d


# ── Singleton state ──────────────────────────────────────
_sim = SimStatus()

# ── Attack‑node / traffic‑node container tracking ───────
# Maps node_id → list of (container_id, container_name) tuples
_attack_containers: dict[str, list[tuple[str, str]]] = {}
_traffic_containers: dict[str, list[tuple[str, str]]] = {}

# Attack category (canvas UI) → CVAE class_id
ATTACK_CATEGORY_CLASS_MAP: dict[str, int] = {
    "ddos":         6,
    "port-scan":    5,
    "botnet":       9,
    "mitm":         10,
    "replay":       8,
    "malformed":    11,
    "iot-protocol": 3,
}

# CVAE class names (for logging / WS messages)
CVAE_CLASS_NAMES: dict[int, str] = {
    0: "benign", 1: "dos hulk", 2: "dos goldeneye", 3: "dos slowloris",
    4: "dos slowhttptest", 5: "portscan", 6: "ddos", 7: "ftp patator",
    8: "ssh patator", 9: "bot", 10: "infiltration", 11: "heartbleed",
    12: "web attack brute force", 13: "web attack xss",
    14: "web attack sql injection",
}


async def resolve_device_owners(
    db: AsyncSession,
    device_ids: list[str],
) -> dict[str, str]:
    """
    Resolve device UUIDs → owning FL client ``client_id`` strings.

    Returns a mapping ``{device_uuid_str: client_id_str}``.
    Raises ``ValueError`` if any device is not found or has no owning client.
    """
    from app.models.device import Device
    from app.models.fl import FLClient

    result: dict[str, str] = {}
    for dev_id_str in device_ids:
        try:
            dev_uuid = UUID(dev_id_str)
        except ValueError:
            raise ValueError(f"Invalid device UUID: {dev_id_str}")

        stmt = (
            select(Device)
            .options(selectinload(Device.fl_client))
            .where(Device.id == dev_uuid)
        )
        row = await db.execute(stmt)
        device = row.scalar_one_or_none()
        if device is None:
            raise ValueError(f"Device {dev_id_str} not found in database")
        if device.fl_client is None:
            raise ValueError(
                f"Device {dev_id_str} ({device.name}) has no owning FL client"
            )
        result[dev_id_str] = device.fl_client.client_id
    return result


def get_status() -> SimStatus:
    """Return current simulation status (with live uptime)."""
    if _sim.started_at and _sim.state == SimState.RUNNING:
        _sim.uptime_seconds = time.time() - _sim.started_at
        # Auto‑stop if duration exceeded
        if _sim.config.duration_seconds > 0:
            if _sim.uptime_seconds >= _sim.config.duration_seconds:
                log.info("Simulation duration reached — auto‑stopping")
                import asyncio
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        loop.create_task(stop_simulation())
                except Exception:
                    pass
    return _sim


# ── Scenario Discovery ──────────────────────────────────

def list_scenarios() -> list[dict]:
    """
    Discover available scenario packs from the filesystem.
    Each entry includes user‑friendly metadata for the UI.
    """
    scenarios: list[dict] = []

    scenario_dir = _find_scenario_dir()
    if scenario_dir is None:
        log.warning("No scenario directory found — only client_data available")

    # Build list from the on‑disk packs
    if scenario_dir:
        for entry in sorted(scenario_dir.iterdir()):
            if not entry.is_dir():
                continue
            meta_path = entry / "metadata.json"
            meta: dict = {}
            if meta_path.exists():
                try:
                    with open(meta_path) as f:
                        meta = json.load(f)
                except Exception as exc:
                    log.warning("Bad metadata for %s: %s", entry.name, exc)

            scenarios.append({
                "name": meta.get("name", entry.name),
                "description": meta.get("description",
                                        SCENARIO_FRIENDLY.get(entry.name,
                                                              f"Scenario: {entry.name}")),
                "attack_labels": meta.get("attack_labels", []),
                "total_windows": meta.get("total_windows", 0),
                "attack_rate": meta.get("attack_rate", 0),
                "flow_rate": SCENARIO_FLOW_RATES.get(entry.name, 5.0),
                "is_default": False,
            })

    # Always append "client_data" as the last option
    scenarios.append({
        "name": "client_data",
        "description": "Use each client's own training‑data partition (default)",
        "attack_labels": ["mixed"],
        "total_windows": 0,
        "attack_rate": 0,
        "flow_rate": SCENARIO_FLOW_RATES["client_data"],
        "is_default": True,
    })

    return scenarios


# ── Simulation Control ───────────────────────────────────

async def start_simulation(
    scenario: str,
    duration: str,
    client_ids: list[str],
) -> SimStatus:
    """
    Start traffic simulation for the given clients.

    Creates *separate* Docker containers (``iot_ids_sim_<id>``) that run the
    FL‑client image in MONITOR mode — existing FL training containers are
    untouched.

    Parameters
    ----------
    scenario   : scenario name (e.g. "ddos_attack") or "" / "client_data"
    duration   : "5min" | "30min" | "continuous"
    client_ids : list of client_id strings from the DB
    """
    global _sim

    from app.services import docker_service
    from app.core.websocket import ws_manager, WSMessageType, build_ws_message

    if _sim.state == SimState.RUNNING:
        raise ValueError("A simulation is already running. Stop it first.")

    # ── Resolve config ───────────────────────────
    effective_scenario = scenario if scenario and scenario != "client_data" else ""
    flow_rate = SCENARIO_FLOW_RATES.get(scenario or "client_data", 5.0)
    monitor_interval = max(0.2, 1.0 / flow_rate)
    dur_seconds = DURATION_PRESETS.get(duration, 0)

    config = SimConfig(
        scenario=effective_scenario or "client_data",
        duration=duration,
        duration_seconds=dur_seconds,
        flow_rate=flow_rate,
        monitor_interval=round(monitor_interval, 3),
        clients=list(client_ids),
    )

    _sim.state = SimState.STARTING
    _sim.config = config
    _sim.clients = []
    _sim.started_at = time.time()
    _sim.uptime_seconds = 0.0
    _sim.scenario_description = SCENARIO_FRIENDLY.get(
        scenario or "client_data",
        "Custom scenario",
    )

    log.info(
        "Starting simulation: scenario=%s  rate=%.1f/s  interval=%.2fs  "
        "duration=%s  clients=%s",
        config.scenario, flow_rate, monitor_interval, duration, client_ids,
    )

    # Broadcast starting
    await ws_manager.broadcast(build_ws_message(
        WSMessageType.SIMULATION_STATUS,
        {"state": "starting", "scenario": config.scenario},
    ))

    host_root = settings.HOST_PROJECT_ROOT

    for cid in client_ids:
        cs = ClientSimStatus(client_id=cid)
        try:
            # Environment for the monitor container
            env: dict[str, str] = {
                "CLIENT_ID": cid,
                "FL_SERVER_URL": f"{docker_service.FL_SERVER_CONTAINER}:{settings.FL_SERVER_PORT}",
                "DATA_PATH": "/app/data",
                "BACKEND_URL": "http://iot_ids_backend:8000",
                "MODE": "MONITOR",
                "MONITOR_INTERVAL": str(monitor_interval),
                "REPLAY_SPEED": "1.0",
                "REPLAY_LOOP": "true",
                "REPLAY_SHUFFLE": "true",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUNBUFFERED": "1",
            }
            if effective_scenario:
                env["SCENARIO"] = effective_scenario
                env["SCENARIO_DIR"] = "/app/scenarios"
            if dur_seconds > 0:
                env["MAX_DURATION"] = str(dur_seconds)

            # Volume mounts — all host‑absolute paths
            host_data = os.path.join(host_root, "data", "clients", cid.lower())
            host_fl_common = os.path.join(host_root, "fl_common")
            host_fl_client = os.path.join(host_root, "fl_client")
            host_model = os.path.join(host_root, "model")
            host_scenarios = os.path.join(host_root, "data", "scenarios")

            volumes = {
                host_fl_client: {"bind": "/app", "mode": "rw"},
                host_fl_common: {"bind": "/fl_common", "mode": "rw"},
                host_data:      {"bind": "/app/data", "mode": "ro"},
                host_model:     {"bind": "/app/models", "mode": "ro"},
                host_scenarios: {"bind": "/app/scenarios", "mode": "ro"},
            }

            container_name = f"iot_ids_sim_{cid.lower()}"
            docker_service._remove_if_exists(container_name)

            dk = docker_service._get_docker()
            container = dk.containers.create(
                image=docker_service.FL_CLIENT_IMAGE,
                name=container_name,
                environment=env,
                volumes=volumes,
                network=docker_service.DOCKER_NETWORK,
                restart_policy={"Name": "no"},
                detach=True,
            )
            container.start()
            container.reload()

            cs.container_id = container.id
            cs.container_name = container.name
            cs.state = SimState.RUNNING
            cs.started_at = time.time()
            log.info("Started sim container %s for %s", container.name, cid)

        except Exception as exc:
            log.error("Failed to start sim for %s: %s", cid, exc)
            cs.state = SimState.ERROR
            cs.error = str(exc)

        _sim.clients.append(cs)

    running = [c for c in _sim.clients if c.state == SimState.RUNNING]
    _sim.state = SimState.RUNNING if running else SimState.ERROR

    await ws_manager.broadcast(build_ws_message(
        WSMessageType.SIMULATION_STATUS,
        get_status().to_dict(),
    ))
    return _sim


async def stop_simulation() -> SimStatus:
    """Stop all running simulation containers and reset state."""
    global _sim

    from app.services import docker_service
    from app.core.websocket import ws_manager, WSMessageType, build_ws_message

    if _sim.state not in (SimState.RUNNING, SimState.ERROR):
        raise ValueError(f"No simulation to stop (state={_sim.state.value})")

    _sim.state = SimState.STOPPING

    for cs in _sim.clients:
        if cs.container_id:
            try:
                docker_service.stop_container(cs.container_id)
                docker_service.remove_container(cs.container_id)
                log.info("Stopped sim container %s", cs.container_name)
            except Exception as exc:
                log.warning("Error stopping %s: %s", cs.container_name, exc)
        cs.state = SimState.IDLE
        cs.container_id = None
        cs.container_name = None

    _sim.state = SimState.IDLE
    _sim.uptime_seconds = 0.0
    _sim.started_at = None

    await ws_manager.broadcast(build_ws_message(
        WSMessageType.SIMULATION_STATUS,
        get_status().to_dict(),
    ))
    return _sim


async def get_container_statuses() -> list[dict]:
    """Poll Docker for live container state of every sim client."""
    from app.services import docker_service

    results = []
    for cs in _sim.clients:
        info: dict = {"client_id": cs.client_id, "state": cs.state.value}
        if cs.container_id:
            ci = docker_service.get_container_status(cs.container_id)
            if ci:
                info["container_status"] = ci.status
                info["container_name"] = ci.name
            else:
                info["container_status"] = "not_found"
                cs.state = SimState.ERROR
                cs.error = "Container disappeared"
        results.append(info)
    return results


# ── Attack‑Node Simulation (CVAE) ───────────────────────

async def start_attack_node_sim(
    attack_node_id: str,
    attack_category: str,
    target_device_ids: list[str],
    db: AsyncSession,
    intensity: float = 0.8,
) -> dict:
    """
    Spawn one CVAE container per target device for an attack node.

    Parameters
    ----------
    attack_node_id   : unique canvas node ID (used as run_id too)
    attack_category  : UI category string (e.g. "ddos", "port-scan")
    target_device_ids: list of device_id strings to attack
    db               : async DB session for device → client resolution
    intensity        : 0.0‑1.0 maps to CVAE attack_ratio

    Returns
    -------
    dict with run_id, attack_node_id, container_names, class_id, status
    """
    from app.services import docker_service
    from app.core.websocket import ws_manager, WSMessageType, build_ws_message

    # ── Validate ─────────────────────────────────
    if attack_node_id in _attack_containers:
        raise ValueError(
            f"Attack node {attack_node_id} already has running containers. "
            "Stop it first."
        )

    cvae_class_id = ATTACK_CATEGORY_CLASS_MAP.get(attack_category)
    if cvae_class_id is None:
        raise ValueError(
            f"Unknown attack category '{attack_category}'. "
            f"Valid: {list(ATTACK_CATEGORY_CLASS_MAP.keys())}"
        )

    if not target_device_ids:
        raise ValueError("At least one target device is required.")

    # ── Resolve device UUIDs → owning FL client IDs ──
    device_to_client = await resolve_device_owners(db, target_device_ids)
    log.info(
        "Resolved device→client mapping: %s",
        {d[:8]: c for d, c in device_to_client.items()},
    )

    attack_ratio = max(0.0, min(1.0, intensity))
    run_id = attack_node_id  # reuse attackId as run_id per spec

    log.info(
        "Starting attack-node sim: node=%s  category=%s  class=%d(%s)  "
        "ratio=%.2f  devices=%s",
        attack_node_id, attack_category, cvae_class_id,
        CVAE_CLASS_NAMES.get(cvae_class_id, "?"),
        attack_ratio, target_device_ids,
    )

    # Broadcast pending status
    await ws_manager.broadcast(build_ws_message(
        WSMessageType.ATTACK_STATUS,
        {
            "run_id": run_id,
            "attack_id": attack_node_id,
            "status": "pending",
            "attack_category": attack_category,
            "class_id": cvae_class_id,
            "target_device_ids": target_device_ids,
        },
    ))

    # ── Spawn containers ─────────────────────────
    host_root = settings.HOST_PROJECT_ROOT
    containers: list[tuple[str, str]] = []

    for device_id in target_device_ids:
        short_dev = device_id[:8]
        client_id = device_to_client[device_id]
        container_name = f"iot_ids_attack_{attack_node_id[:12]}_{short_dev}"

        env: dict[str, str] = {
            "CLIENT_ID": client_id,
            "BACKEND_URL": "http://iot_ids_backend:8000",
            "MODE": "MONITOR",
            "MONITOR_INTERVAL": "0.5",
            "USE_CVAE": "true",
            "ATTACK_CLASS_ID": str(cvae_class_id),
            "ATTACK_RATIO": str(attack_ratio),
            "DEVICE_ID": device_id,
            "ATTACK_NODE_ID": attack_node_id,
            "REPLAY_LOOP": "true",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
        }
        # No MAX_DURATION — runs indefinitely until stop

        host_fl_client = os.path.join(host_root, "fl_client")
        host_fl_common = os.path.join(host_root, "fl_common")
        host_model = os.path.join(host_root, "model")
        host_data = os.path.join(host_root, "data", "clients", client_id.lower())

        volumes = {
            host_fl_client: {"bind": "/app", "mode": "rw"},
            host_fl_common: {"bind": "/fl_common", "mode": "rw"},
            host_model:     {"bind": "/app/models", "mode": "ro"},
            host_data:      {"bind": "/app/data", "mode": "ro"},
        }

        try:
            docker_service._remove_if_exists(container_name)
            dk = docker_service._get_docker()
            container = dk.containers.create(
                image=docker_service.FL_CLIENT_IMAGE,
                name=container_name,
                environment=env,
                volumes=volumes,
                network=docker_service.DOCKER_NETWORK,
                restart_policy={"Name": "no"},
                detach=True,
            )
            container.start()
            container.reload()
            containers.append((container.id, container.name))
            log.info(
                "Started attack container %s → device %s (class=%d)",
                container.name, device_id, cvae_class_id,
            )
        except Exception as exc:
            log.error(
                "Failed to start attack container for device %s: %s",
                device_id, exc,
            )
            # Clean up already‑started containers on partial failure
            for cid, cname in containers:
                try:
                    docker_service.stop_container(cid)
                    docker_service.remove_container(cid)
                except Exception:
                    pass
            # Broadcast failure
            await ws_manager.broadcast(build_ws_message(
                WSMessageType.ATTACK_STATUS,
                {
                    "run_id": run_id,
                    "attack_id": attack_node_id,
                    "status": "failed",
                    "error_message": str(exc),
                },
            ))
            raise ValueError(f"Failed to start attack container: {exc}")

    _attack_containers[attack_node_id] = containers

    # Broadcast running status
    await ws_manager.broadcast(build_ws_message(
        WSMessageType.ATTACK_STATUS,
        {
            "run_id": run_id,
            "attack_id": attack_node_id,
            "status": "running",
            "attack_category": attack_category,
            "class_id": cvae_class_id,
            "target_device_ids": target_device_ids,
            "container_count": len(containers),
        },
    ))

    return {
        "run_id": run_id,
        "attack_node_id": attack_node_id,
        "container_names": [cn for _, cn in containers],
        "class_id": cvae_class_id,
        "class_name": CVAE_CLASS_NAMES.get(cvae_class_id, "unknown"),
        "attack_ratio": attack_ratio,
        "status": "running",
    }


async def stop_attack_node_sim(attack_node_id: str) -> dict:
    """
    Stop all containers for an attack node and clean up tracking state.

    Returns
    -------
    dict with run_id, status, containers_stopped
    """
    from app.services import docker_service
    from app.core.websocket import ws_manager, WSMessageType, build_ws_message

    containers = _attack_containers.pop(attack_node_id, [])
    if not containers:
        raise ValueError(
            f"No running containers for attack node {attack_node_id}"
        )

    stopped = 0
    for cid, cname in containers:
        try:
            docker_service.stop_container(cid)
            docker_service.remove_container(cid)
            stopped += 1
            log.info("Stopped attack container %s", cname)
        except Exception as exc:
            log.warning("Error stopping attack container %s: %s", cname, exc)

    # Broadcast cancelled status
    await ws_manager.broadcast(build_ws_message(
        WSMessageType.ATTACK_STATUS,
        {
            "run_id": attack_node_id,
            "attack_id": attack_node_id,
            "status": "cancelled",
        },
    ))

    return {
        "run_id": attack_node_id,
        "attack_node_id": attack_node_id,
        "status": "cancelled",
        "containers_stopped": stopped,
    }


# ── Traffic‑Node Simulation (CVAE benign) ───────────────

async def start_traffic_node_sim(
    traffic_node_id: str,
    target_device_ids: list[str],
    db: AsyncSession,
    flow_rate: float = 5.0,
) -> dict:
    """
    Spawn one CVAE container per target device for benign traffic generation.

    Uses CVAE class_id=0 (benign) with attack_ratio=0.0.

    Parameters
    ----------
    traffic_node_id  : unique canvas node ID
    target_device_ids: list of device_id strings to send benign traffic to
    db               : async DB session for device → client resolution
    flow_rate        : flows per second (controls monitor_interval)

    Returns
    -------
    dict with run_id, traffic_node_id, container_names, status
    """
    from app.services import docker_service
    from app.core.websocket import ws_manager, WSMessageType, build_ws_message

    if traffic_node_id in _traffic_containers:
        raise ValueError(
            f"Traffic node {traffic_node_id} already has running containers. "
            "Stop it first."
        )

    if not target_device_ids:
        raise ValueError("At least one target device is required.")

    # ── Resolve device UUIDs → owning FL client IDs ──
    device_to_client = await resolve_device_owners(db, target_device_ids)
    log.info(
        "Traffic node resolved device→client: %s",
        {d[:8]: c for d, c in device_to_client.items()},
    )

    monitor_interval = max(0.2, 1.0 / flow_rate)
    run_id = traffic_node_id

    log.info(
        "Starting traffic-node sim: node=%s  class=0(benign)  "
        "interval=%.2fs  devices=%s",
        traffic_node_id, monitor_interval, target_device_ids,
    )

    host_root = settings.HOST_PROJECT_ROOT
    containers: list[tuple[str, str]] = []

    for device_id in target_device_ids:
        short_dev = device_id[:8]
        client_id = device_to_client[device_id]
        container_name = f"iot_ids_traffic_{traffic_node_id[:12]}_{short_dev}"

        env: dict[str, str] = {
            "CLIENT_ID": client_id,
            "BACKEND_URL": "http://iot_ids_backend:8000",
            "MODE": "MONITOR",
            "MONITOR_INTERVAL": str(round(monitor_interval, 3)),
            "USE_CVAE": "true",
            "ATTACK_CLASS_ID": "0",
            "ATTACK_RATIO": "0.0",
            "DEVICE_ID": device_id,
            "TRAFFIC_NODE_ID": traffic_node_id,
            "REPLAY_LOOP": "true",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
        }

        host_fl_client = os.path.join(host_root, "fl_client")
        host_fl_common = os.path.join(host_root, "fl_common")
        host_model = os.path.join(host_root, "model")
        host_data = os.path.join(host_root, "data", "clients", client_id.lower())

        volumes = {
            host_fl_client: {"bind": "/app", "mode": "rw"},
            host_fl_common: {"bind": "/fl_common", "mode": "rw"},
            host_model:     {"bind": "/app/models", "mode": "ro"},
            host_data:      {"bind": "/app/data", "mode": "ro"},
        }

        try:
            docker_service._remove_if_exists(container_name)
            dk = docker_service._get_docker()
            container = dk.containers.create(
                image=docker_service.FL_CLIENT_IMAGE,
                name=container_name,
                environment=env,
                volumes=volumes,
                network=docker_service.DOCKER_NETWORK,
                restart_policy={"Name": "no"},
                detach=True,
            )
            container.start()
            container.reload()
            containers.append((container.id, container.name))
            log.info("Started traffic container %s → device %s", container.name, device_id)
        except Exception as exc:
            log.error(
                "Failed to start traffic container for device %s: %s",
                device_id, exc,
            )
            for cid, cname in containers:
                try:
                    docker_service.stop_container(cid)
                    docker_service.remove_container(cid)
                except Exception:
                    pass
            raise ValueError(f"Failed to start traffic container: {exc}")

    _traffic_containers[traffic_node_id] = containers

    return {
        "run_id": run_id,
        "traffic_node_id": traffic_node_id,
        "container_names": [cn for _, cn in containers],
        "class_id": 0,
        "class_name": "benign",
        "status": "running",
    }


async def stop_traffic_node_sim(traffic_node_id: str) -> dict:
    """
    Stop all containers for a traffic node and clean up tracking state.

    Returns
    -------
    dict with run_id, status, containers_stopped
    """
    from app.services import docker_service

    containers = _traffic_containers.pop(traffic_node_id, [])
    if not containers:
        raise ValueError(
            f"No running containers for traffic node {traffic_node_id}"
        )

    stopped = 0
    for cid, cname in containers:
        try:
            docker_service.stop_container(cid)
            docker_service.remove_container(cid)
            stopped += 1
            log.info("Stopped traffic container %s", cname)
        except Exception as exc:
            log.warning("Error stopping traffic container %s: %s", cname, exc)

    return {
        "run_id": traffic_node_id,
        "traffic_node_id": traffic_node_id,
        "status": "stopped",
        "containers_stopped": stopped,
    }
