"""
Docker SDK service — dynamically create / manage FL client containers.

The backend container must have /var/run/docker.sock mounted to talk to the
Docker daemon on the host.
"""

from __future__ import annotations

import logging
import os
import platform
from dataclasses import dataclass
from typing import Optional

import docker
from docker.errors import NotFound, APIError, ImageNotFound

from app.config import settings

log = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────
FL_CLIENT_IMAGE = "iot-ids-fl-client:latest"
FL_SERVER_IMAGE = "iot-ids-fl-server:latest"
DOCKER_NETWORK = "iot_ids_network"
CONTAINER_PREFIX = "iot_ids_fl_client_"
FL_SERVER_CONTAINER = "iot_ids_fl_server"


# ── Container info DTO ───────────────────────────────────
@dataclass
class ContainerInfo:
    container_id: str
    name: str
    status: str  # created | running | paused | restarting | exited | dead
    image: str


# ── Lazy Docker client ──────────────────────────────────
_docker_client: Optional[docker.DockerClient] = None


def _get_docker() -> docker.DockerClient:
    """Return a cached Docker client (connects via /var/run/docker.sock)."""
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


# ── Public API ───────────────────────────────────────────

def create_client_container(
    client_id: str,
    data_path: str = "/app/data",
    *,
    fl_server_url: str | None = None,
    mode: str = "IDLE",
    auto_start: bool = False,
) -> ContainerInfo:
    """
    Create (but don't start) a Docker container for an FL client.

    Parameters
    ----------
    client_id   : Unique short id, e.g. "bank_a"
    data_path   : Path *inside the container* where data is mounted
    fl_server_url : Override FL server address (default from settings)
    mode        : Operating mode — IDLE | MONITOR | TRAIN
    auto_start  : Start the container immediately after creation

    Returns
    -------
    ContainerInfo with container_id, name, status, image
    """
    dk = _get_docker()
    container_name = f"{CONTAINER_PREFIX}{client_id.lower()}"

    # HOST_PROJECT_ROOT is the absolute path to the project on the *host*.
    # Since the backend runs inside Docker but talks to the host daemon via
    # the mounted socket, all volume source paths must be host-absolute.
    host_root = settings.HOST_PROJECT_ROOT

    # Normalise path separators — Docker on Windows still accepts forward slashes
    host_data_dir = os.path.join(host_root, "data", "clients", client_id.lower())
    host_fl_common = os.path.join(host_root, "fl_common")
    host_fl_client = os.path.join(host_root, "fl_client")
    host_model = os.path.join(host_root, "model")

    server_url = fl_server_url or f"{FL_SERVER_CONTAINER}:{settings.FL_SERVER_PORT}"

    environment = {
        "CLIENT_ID": client_id,
        "FL_SERVER_URL": server_url,
        "DATA_PATH": data_path,
        "BACKEND_URL": "http://iot_ids_backend:8000",
        "MODE": mode.upper(),
    }

    volumes = {
        host_fl_client: {"bind": "/app", "mode": "rw"},
        host_fl_common: {"bind": "/fl_common", "mode": "rw"},
        host_data_dir:  {"bind": "/app/data", "mode": "ro"},
        host_model:     {"bind": "/app/models", "mode": "ro"},
    }

    log.info("Creating container %s (image=%s)", container_name, FL_CLIENT_IMAGE)

    # Remove stale container with same name (if any)
    _remove_if_exists(container_name)

    container = dk.containers.create(
        image=FL_CLIENT_IMAGE,
        name=container_name,
        environment=environment,
        volumes=volumes,
        network=DOCKER_NETWORK,
        restart_policy={"Name": "no"},
        detach=True,
    )

    if auto_start:
        container.start()
        container.reload()

    return ContainerInfo(
        container_id=container.id,
        name=container.name,
        status=container.status,
        image=FL_CLIENT_IMAGE,
    )


def start_container(container_id: str) -> ContainerInfo:
    """Start a stopped container."""
    dk = _get_docker()
    container = dk.containers.get(container_id)
    container.start()
    container.reload()
    log.info("Started container %s (%s)", container.name, container.short_id)
    return _to_info(container)


def stop_container(container_id: str, timeout: int = 10) -> ContainerInfo:
    """Stop a running container."""
    dk = _get_docker()
    container = dk.containers.get(container_id)
    container.stop(timeout=timeout)
    container.reload()
    log.info("Stopped container %s (%s)", container.name, container.short_id)
    return _to_info(container)


def remove_container(container_id: str, force: bool = True) -> None:
    """Remove a container (force-kill if running)."""
    dk = _get_docker()
    try:
        container = dk.containers.get(container_id)
        log.info("Removing container %s (%s)", container.name, container.short_id)
        container.remove(force=force)
    except NotFound:
        log.warning("Container %s not found — already removed", container_id)


def get_container_status(container_id: str) -> ContainerInfo | None:
    """Get current status of a container. Returns None if not found."""
    dk = _get_docker()
    try:
        container = dk.containers.get(container_id)
        container.reload()
        return _to_info(container)
    except NotFound:
        return None


def list_containers(all: bool = True) -> list[ContainerInfo]:
    """List all FL client containers (matching our prefix)."""
    dk = _get_docker()
    containers = dk.containers.list(all=all, filters={"name": CONTAINER_PREFIX})
    return [_to_info(c) for c in containers]


def ensure_image_exists() -> bool:
    """
    Check that the FL client Docker image exists.
    Returns True if image is available.
    """
    dk = _get_docker()
    try:
        dk.images.get(FL_CLIENT_IMAGE)
        return True
    except ImageNotFound:
        log.warning(
            "FL client image '%s' not found. "
            "Run: docker build -t %s ./fl_client",
            FL_CLIENT_IMAGE,
            FL_CLIENT_IMAGE,
        )
        return False


# ── Data Validation ──────────────────────────────────────

def validate_client_data(client_id: str) -> bool:
    """
    Check if a client has training data (.npy files) in its data directory.
    The backend has client data mounted at /app/client_data/<client_id>/
    Returns True if at least one X_seq_chunk and y_seq_chunk file exist.
    """
    # Inside Docker container, client data is at /app/client_data/<id>/
    data_dir = os.path.join("/app", "client_data", client_id.lower())

    if not os.path.isdir(data_dir):
        log.warning("Data directory not found: %s", data_dir)
        return False

    files = os.listdir(data_dir)
    has_x = any(f.startswith("X_seq") and f.endswith(".npy") for f in files)
    has_y = any(f.startswith("y_seq") and f.endswith(".npy") for f in files)

    if not (has_x and has_y):
        log.warning("No training data in %s (X_seq: %s, y_seq: %s)", data_dir, has_x, has_y)
        return False

    return True


# ── FL Server Container Management ───────────────────────

def start_fl_server(
    *,
    num_rounds: int = 5,
    min_clients: int = 2,
    use_he: bool = True,
) -> ContainerInfo:
    """
    Create and start the FL server container.

    Removes any existing server container first to ensure clean state.
    """
    dk = _get_docker()
    host_root = settings.HOST_PROJECT_ROOT

    host_fl_server = os.path.join(host_root, "fl_server")
    host_fl_common = os.path.join(host_root, "fl_common")
    host_model = os.path.join(host_root, "model")

    environment = {
        "ROUNDS": str(num_rounds),
        "MIN_CLIENTS": str(min_clients),
        "MIN_FIT_CLIENTS": str(min_clients),
        "USE_HE": "true" if use_he else "false",
        "FL_SERVER_ADDRESS": "0.0.0.0:8080",
        "BACKEND_URL": "http://iot_ids_backend:8000",
    }

    volumes = {
        host_fl_server: {"bind": "/app", "mode": "rw"},
        host_fl_common: {"bind": "/fl_common", "mode": "rw"},
        host_model:     {"bind": "/app/models", "mode": "rw"},
    }

    log.info("Starting FL server container (rounds=%d, clients=%d, HE=%s)",
             num_rounds, min_clients, use_he)

    _remove_if_exists(FL_SERVER_CONTAINER)

    container = dk.containers.create(
        image=FL_SERVER_IMAGE,
        name=FL_SERVER_CONTAINER,
        environment=environment,
        volumes=volumes,
        network=DOCKER_NETWORK,
        ports={"8080/tcp": 8080},
        restart_policy={"Name": "no"},
        detach=True,
    )

    # Add network alias so clients can reach it as "fl_server" (docker-compose service name)
    try:
        network = dk.networks.get(DOCKER_NETWORK)
        network.disconnect(container)
        network.connect(container, aliases=["fl_server", FL_SERVER_CONTAINER])
    except Exception as exc:
        log.warning("Failed to set network alias for FL server: %s", exc)

    container.start()
    container.reload()

    return _to_info(container)


def stop_fl_server() -> None:
    """Stop and remove the FL server container."""
    dk = _get_docker()
    try:
        container = dk.containers.get(FL_SERVER_CONTAINER)
        container.stop(timeout=10)
        container.remove(force=True)
        log.info("FL server container stopped and removed")
    except NotFound:
        log.warning("FL server container not found")


def get_fl_server_status() -> ContainerInfo | None:
    """Get FL server container status."""
    dk = _get_docker()
    try:
        container = dk.containers.get(FL_SERVER_CONTAINER)
        container.reload()
        return _to_info(container)
    except NotFound:
        return None


# ── Helpers ──────────────────────────────────────────────

def _to_info(container) -> ContainerInfo:
    """Convert a docker container object to our DTO."""
    return ContainerInfo(
        container_id=container.id,
        name=container.name,
        status=container.status,
        image=str(container.image.tags[0]) if container.image.tags else "unknown",
    )


def _remove_if_exists(name: str) -> None:
    """Remove a container by name if it exists (cleanup stale runs)."""
    dk = _get_docker()
    try:
        old = dk.containers.get(name)
        old.remove(force=True)
        log.info("Removed stale container %s", name)
    except NotFound:
        pass
