"""
Simulation service — manages traffic‑replay simulations.

Spins up *separate* Docker containers (named ``iot_ids_sim_<client>``) that run
the FL‑client image in **MONITOR** mode.  Each container loads the trained
CNN‑LSTM model, replays real CIC‑IDS2017 data (scenario or client partition),
runs inference, and POSTs predictions to the backend.

Design decisions (from user review):
  • Replay speed is *automatic* per scenario — no manual knob.
  • Loop/shuffle are always on — hidden from the user.
  • Duration is chosen via a simple selector (5 min / 30 min / continuous).
  • FL‑training containers are *not* touched — separate sim containers.
  • Clients are loaded dynamically from the database.
  • Clients must have registered devices — no virtual device auto‑creation.
  • Synthetic traffic is generated on-the-fly matching real CIC-IDS2017 profiles.
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
