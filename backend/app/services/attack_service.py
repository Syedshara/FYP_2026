"""
Attack engine service — CRUD for attack templates + Docker container lifecycle.

Manages:
  - Attack template persistence (create, list, get, update, delete)
  - AttackRun lifecycle (spawn Docker container, track status, collect results)
  - Attack catalog (available attack types and variants)

Docker pattern follows docker_service.py: create container → start → monitor → collect.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.attack import Attack, AttackRun
from app.schemas.attack import AttackCreate, AttackUpdate, AttackRunRequest

log = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────

ATTACK_ENGINE_IMAGE = "iot_ids_attack_engine:latest"
DOCKER_NETWORK = "iot_ids_network"
CONTAINER_PREFIX = "iot_ids_attack_"

# ── Attack Catalog ───────────────────────────────────────

ATTACK_CATALOG: dict[str, list[dict[str, Any]]] = {
    "ddos": [
        {
            "sub_type": "syn_flood",
            "label": "SYN Flood",
            "description": "TCP SYN flood — overwhelms target with half-open connections",
            "default_params": {"packet_rate": 1000, "packet_size": 64},
        },
        {
            "sub_type": "udp_flood",
            "label": "UDP Flood",
            "description": "UDP packet flood — saturates bandwidth with random UDP datagrams",
            "default_params": {"packet_rate": 2000, "packet_size": 512},
        },
        {
            "sub_type": "icmp_flood",
            "label": "ICMP Flood",
            "description": "Ping flood — overwhelms target with ICMP echo requests",
            "default_params": {"packet_rate": 1500, "packet_size": 64},
        },
        {
            "sub_type": "http_flood",
            "label": "HTTP Flood",
            "description": "Layer 7 HTTP GET/POST flood — exhausts web server resources",
            "default_params": {"request_rate": 500, "method": "GET", "path": "/"},
        },
    ],
    "mitm": [
        {
            "sub_type": "arp_spoof",
            "label": "ARP Spoofing",
            "description": "ARP cache poisoning — intercepts traffic between two hosts",
            "default_params": {"interval": 2},
        },
        {
            "sub_type": "dns_poison",
            "label": "DNS Poisoning",
            "description": "DNS response spoofing — redirects domain resolution",
            "default_params": {"domain": "example.com", "spoofed_ip": "10.0.0.99"},
        },
    ],
    "port-scan": [
        {
            "sub_type": "syn_scan",
            "label": "SYN Scan",
            "description": "Half-open TCP scan — stealthy port discovery",
            "default_params": {"port_range": "1-1024", "rate": 100},
        },
        {
            "sub_type": "udp_scan",
            "label": "UDP Scan",
            "description": "UDP port scan — discovers open UDP services",
            "default_params": {"port_range": "1-1024", "rate": 50},
        },
        {
            "sub_type": "stealth_scan",
            "label": "Stealth Scan",
            "description": "FIN/NULL/Xmas scan — evades simple firewall rules",
            "default_params": {"scan_type": "fin", "port_range": "1-1024", "rate": 80},
        },
    ],
    "replay": [
        {
            "sub_type": "pcap_replay",
            "label": "PCAP Replay",
            "description": "Replay captured traffic from a PCAP file",
            "default_params": {"pcap_path": "/data/captures/sample.pcap", "loop": 1, "speed": 1.0},
        },
    ],
    "malformed": [
        {
            "sub_type": "malformed_tcp",
            "label": "Malformed TCP",
            "description": "Send TCP packets with invalid flags/checksums/options",
            "default_params": {"packet_rate": 200, "variant": "bad_flags"},
        },
        {
            "sub_type": "malformed_udp",
            "label": "Malformed UDP",
            "description": "Send UDP packets with invalid length/checksum fields",
            "default_params": {"packet_rate": 200, "variant": "bad_length"},
        },
        {
            "sub_type": "oversized_packets",
            "label": "Oversized Packets",
            "description": "Send packets exceeding MTU to trigger fragmentation issues",
            "default_params": {"packet_rate": 100, "packet_size": 65535},
        },
    ],
    "botnet": [
        {
            "sub_type": "cnc_beacon",
            "label": "C&C Beacon",
            "description": "Simulate botnet C&C communication beacons",
            "default_params": {"beacon_interval": 5, "domain": "c2.evil.com"},
        },
        {
            "sub_type": "dga_traffic",
            "label": "DGA Traffic",
            "description": "Generate Domain Generation Algorithm DNS queries",
            "default_params": {"dga_seed": 42, "domains_per_batch": 50},
        },
        {
            "sub_type": "data_exfil",
            "label": "Data Exfiltration",
            "description": "Simulate data exfiltration via DNS/HTTPS tunneling",
            "default_params": {"method": "dns", "data_size_kb": 100, "chunk_size": 200},
        },
    ],
    "iot-protocol": [
        {
            "sub_type": "mqtt_publish",
            "label": "MQTT Publish Flood",
            "description": "Flood MQTT broker with publish messages",
            "default_params": {"broker": "localhost", "topic": "iot/#", "qos": 0, "message_rate": 500},
        },
        {
            "sub_type": "coap_flood",
            "label": "CoAP Flood",
            "description": "Flood CoAP server with GET/PUT requests",
            "default_params": {"uri": "/sensor/temp", "method": "GET", "rate": 300},
        },
        {
            "sub_type": "modbus_exploit",
            "label": "Modbus Exploit",
            "description": "Send malicious Modbus TCP commands to ICS devices",
            "default_params": {"function_code": 6, "register": 0, "value": 9999},
        },
    ],
}


def get_attack_catalog() -> dict[str, list[dict[str, Any]]]:
    """Return the full catalog of available attack types."""
    return ATTACK_CATALOG


# ── CRUD ─────────────────────────────────────────────────


async def list_attacks(db: AsyncSession, user_id) -> list[Attack]:
    """List all attack templates for a user."""
    result = await db.execute(
        select(Attack)
        .where(Attack.user_id == user_id)
        .order_by(Attack.updated_at.desc())
    )
    return list(result.scalars().all())


async def create_attack(db: AsyncSession, user_id, data: AttackCreate) -> Attack:
    """Create a new attack template."""
    attack = Attack(
        name=data.name,
        description=data.description,
        category=data.category,
        sub_type=data.sub_type,
        target_ip=data.target_ip,
        target_port=data.target_port,
        params=data.params,
        user_id=user_id,
    )
    db.add(attack)
    await db.flush()
    await db.commit()
    await db.refresh(attack)
    return attack


async def get_attack(db: AsyncSession, attack_id: int) -> Attack | None:
    """Get a single attack with its runs."""
    result = await db.execute(
        select(Attack)
        .options(selectinload(Attack.runs))
        .where(Attack.id == attack_id)
    )
    return result.scalar_one_or_none()


async def update_attack(db: AsyncSession, attack_id: int, data: AttackUpdate) -> Attack | None:
    """Update an attack template."""
    result = await db.execute(
        select(Attack).where(Attack.id == attack_id)
    )
    attack = result.scalar_one_or_none()
    if attack is None:
        return None

    if data.name is not None:
        attack.name = data.name
    if data.description is not None:
        attack.description = data.description
    if data.category is not None:
        attack.category = data.category
    if data.sub_type is not None:
        attack.sub_type = data.sub_type
    if data.target_ip is not None:
        attack.target_ip = data.target_ip
    if data.target_port is not None:
        attack.target_port = data.target_port
    if data.params is not None:
        attack.params = data.params

    attack.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(attack)
    return attack


async def delete_attack(db: AsyncSession, attack_id: int) -> bool:
    """Delete an attack template and all its runs."""
    result = await db.execute(
        select(Attack).where(Attack.id == attack_id)
    )
    attack = result.scalar_one_or_none()
    if attack is None:
        return False

    await db.delete(attack)
    await db.commit()
    return True


# ── Run Management ───────────────────────────────────────


async def create_run(
    db: AsyncSession,
    attack: Attack,
    run_request: AttackRunRequest,
) -> AttackRun:
    """Create a new attack run record (status=pending)."""
    run = AttackRun(
        attack_id=attack.id,
        status="pending",
        duration_seconds=run_request.duration_seconds,
        results={
            "intensity": run_request.intensity,
            "target_ip": run_request.target_ip_override or attack.target_ip,
            "target_port": run_request.target_port_override or attack.target_port,
        },
    )
    db.add(run)
    await db.flush()
    await db.commit()
    await db.refresh(run)
    return run


async def get_run(db: AsyncSession, run_id: int) -> AttackRun | None:
    """Get a single attack run."""
    result = await db.execute(
        select(AttackRun).where(AttackRun.id == run_id)
    )
    return result.scalar_one_or_none()


async def update_run_status(
    db: AsyncSession,
    run_id: int,
    *,
    status: str,
    container_id: str | None = None,
    container_name: str | None = None,
    packets_sent: int | None = None,
    packets_captured: int | None = None,
    detections: int | None = None,
    detection_rate: float | None = None,
    error_message: str | None = None,
    results: dict[str, Any] | None = None,
    finished: bool = False,
) -> AttackRun | None:
    """Update an attack run's status and stats."""
    result = await db.execute(
        select(AttackRun).where(AttackRun.id == run_id)
    )
    run = result.scalar_one_or_none()
    if run is None:
        return None

    run.status = status
    if container_id is not None:
        run.container_id = container_id
    if container_name is not None:
        run.container_name = container_name
    if packets_sent is not None:
        run.packets_sent = packets_sent
    if packets_captured is not None:
        run.packets_captured = packets_captured
    if detections is not None:
        run.detections = detections
    if detection_rate is not None:
        run.detection_rate = detection_rate
    if error_message is not None:
        run.error_message = error_message
    if results is not None:
        run.results = {**run.results, **results}
    if finished:
        run.finished_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(run)
    return run


async def list_runs(db: AsyncSession, attack_id: int) -> list[AttackRun]:
    """List all runs for an attack."""
    result = await db.execute(
        select(AttackRun)
        .where(AttackRun.attack_id == attack_id)
        .order_by(AttackRun.started_at.desc())
    )
    return list(result.scalars().all())


# ── Docker Container Lifecycle ───────────────────────────


def spawn_attack_container(
    attack: Attack,
    run: AttackRun,
    run_request: AttackRunRequest,
) -> dict[str, str]:
    """
    Create and start a Docker container for the attack.

    Returns dict with container_id and container_name.
    Raises RuntimeError if Docker is not available.
    """
    try:
        import docker
        from docker.errors import NotFound, APIError, ImageNotFound
    except ImportError:
        raise RuntimeError("docker SDK not installed — cannot spawn attack containers")

    dk = docker.from_env()

    container_name = f"{CONTAINER_PREFIX}{attack.id}_{run.id}"
    target_ip = run_request.target_ip_override or attack.target_ip or "10.0.0.1"
    target_port = run_request.target_port_override or attack.target_port or 80

    environment = {
        "ATTACK_CATEGORY": attack.category,
        "ATTACK_SUB_TYPE": attack.sub_type,
        "TARGET_IP": str(target_ip),
        "TARGET_PORT": str(target_port),
        "DURATION": str(run_request.duration_seconds),
        "INTENSITY": run_request.intensity,
        "ATTACK_PARAMS": _json_dumps(attack.params),
        "RUN_ID": str(run.id),
        "BACKEND_URL": "http://iot_ids_backend:8000",
    }

    # Remove stale container with same name
    try:
        old = dk.containers.get(container_name)
        old.remove(force=True)
    except Exception:
        pass

    try:
        container = dk.containers.create(
            image=ATTACK_ENGINE_IMAGE,
            name=container_name,
            environment=environment,
            network=DOCKER_NETWORK,
            cap_add=["NET_RAW", "NET_ADMIN"],  # Required for Scapy raw sockets
            restart_policy={"Name": "no"},
            detach=True,
        )
        container.start()
        container.reload()

        return {
            "container_id": container.id,
            "container_name": container.name,
        }
    except ImageNotFound:
        raise RuntimeError(
            f"Attack engine image '{ATTACK_ENGINE_IMAGE}' not found. "
            f"Run: docker build -t {ATTACK_ENGINE_IMAGE} ./attack_engine"
        )
    except APIError as exc:
        raise RuntimeError(f"Docker API error: {exc}")


def stop_attack_container(container_id: str) -> None:
    """Stop and remove an attack container."""
    try:
        import docker
        from docker.errors import NotFound
    except ImportError:
        return

    dk = docker.from_env()
    try:
        container = dk.containers.get(container_id)
        container.stop(timeout=5)
        container.remove(force=True)
    except NotFound:
        pass
    except Exception as exc:
        log.warning("Failed to stop attack container %s: %s", container_id, exc)


def get_attack_container_status(container_id: str) -> str | None:
    """Get status of an attack container. Returns None if not found."""
    try:
        import docker
        from docker.errors import NotFound
    except ImportError:
        return None

    dk = docker.from_env()
    try:
        container = dk.containers.get(container_id)
        container.reload()
        return container.status
    except NotFound:
        return None


def _json_dumps(data: dict) -> str:
    """Serialize dict to JSON string for env var."""
    import json
    return json.dumps(data)
