"""
FL Training API endpoints.

- GET  /rounds              — list all FL rounds
- GET  /rounds/{n}          — get specific round + client metrics
- GET  /status              — current training status
- GET  /clients             — list registered FL clients
- POST /clients             — register a new FL client (+ Docker container)
- GET  /clients/{id}        — get a single FL client with devices
- PATCH /clients/{id}       — update an FL client
- DELETE /clients/{id}      — delete an FL client (+ remove Docker container)
- GET  /clients/{id}/devices — list devices for a client
- POST /clients/{id}/container/start  — start client container
- POST /clients/{id}/container/stop   — stop client container
- GET  /clients/{id}/container/status — get container status
- POST /rounds              — record a completed round (called by FL server)
- POST /start               — start FL training session
- POST /stop                — stop FL training session
"""

import logging
from typing import Optional, List
from uuid import UUID
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_db, get_current_user
from app.services import fl_service, device_service, docker_service
from app.core.websocket import ws_manager, WSMessageType, build_ws_message

log = logging.getLogger(__name__)

router = APIRouter()


# ── Response schemas ─────────────────────────────────────

class RoundOut(BaseModel):
    id: int
    round_number: int
    num_clients: int
    global_loss: Optional[float] = None
    global_accuracy: Optional[float] = None
    global_f1: Optional[float] = None
    global_precision: Optional[float] = None
    global_recall: Optional[float] = None
    aggregation_method: str
    he_scheme: Optional[str] = None
    he_poly_modulus: Optional[int] = None
    duration_seconds: Optional[float] = None
    model_config = {"from_attributes": True}


class ClientMetricOut(BaseModel):
    id: int
    round_id: int
    client_id: str
    local_loss: float
    local_accuracy: float
    num_samples: int
    training_time_sec: float
    encrypted: bool
    model_config = {"from_attributes": True}


class RoundDetailOut(RoundOut):
    client_metrics: list[ClientMetricOut] = []


class DeviceBriefOut(BaseModel):
    id: UUID
    name: str
    device_type: str
    status: str
    ip_address: Optional[str] = None
    model_config = {"from_attributes": True}


class FLClientOut(BaseModel):
    id: int
    client_id: str
    name: str
    description: Optional[str] = None
    ip_address: Optional[str] = None
    status: str
    data_path: str
    container_id: Optional[str] = None
    container_name: Optional[str] = None
    total_samples: int = 0
    last_seen_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


class FLClientDetailOut(FLClientOut):
    devices: List[DeviceBriefOut] = []


class FLClientCreate(BaseModel):
    client_id: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    ip_address: Optional[str] = Field(default=None, max_length=45)
    data_path: str = Field(default="/app/data")


class FLClientUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    description: Optional[str] = None
    ip_address: Optional[str] = Field(default=None, max_length=45)
    status: Optional[str] = None
    data_path: Optional[str] = None
    total_samples: Optional[int] = None


class RoundCreate(BaseModel):
    """Payload from FL server to record a completed round."""
    round_number: int
    num_clients: int
    aggregation_method: str = "fedavg_he"
    he_scheme: Optional[str] = "ckks"
    he_poly_modulus: Optional[int] = 16384
    duration_seconds: Optional[float] = None
    global_loss: Optional[float] = None
    global_accuracy: Optional[float] = None
    global_f1: Optional[float] = None
    global_precision: Optional[float] = None
    global_recall: Optional[float] = None


class FLStatusResponse(BaseModel):
    is_training: bool
    current_round: Optional[int] = None
    total_rounds: Optional[int] = None
    active_clients: int = 0
    total_rounds_completed: int = 0


# ── Round Endpoints ──────────────────────────────────────

@router.get("/rounds", response_model=list[RoundOut])
async def list_rounds(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all completed FL training rounds."""
    return await fl_service.get_all_rounds(db)


@router.get("/rounds/{round_number}", response_model=RoundDetailOut)
async def get_round(
    round_number: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get a specific round with client-level metrics."""
    fl_round = await fl_service.get_round_by_number(db, round_number)
    if not fl_round:
        raise HTTPException(status_code=404, detail="Round not found")

    metrics = await fl_service.get_client_metrics_for_round(db, fl_round.id)
    return RoundDetailOut(
        **{c.key: getattr(fl_round, c.key) for c in fl_round.__table__.columns},
        client_metrics=[ClientMetricOut.model_validate(m) for m in metrics],
    )


@router.get("/status", response_model=FLStatusResponse)
async def get_status(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get current FL training status."""
    rounds = await fl_service.get_all_rounds(db)
    active_clients = await fl_service.get_active_fl_clients(db)

    return FLStatusResponse(
        is_training=False,  # TODO: check if FL server is running
        current_round=rounds[-1].round_number if rounds else None,
        total_rounds=len(rounds),
        active_clients=len(active_clients),
        total_rounds_completed=len(rounds),
    )


@router.post("/rounds", response_model=RoundOut, status_code=201)
async def record_round(
    body: RoundCreate,
    db: AsyncSession = Depends(get_db),
):
    """
    Record a completed FL round.
    Called by the FL server after each aggregation round.
    No auth required (internal service-to-service call).
    """
    return await fl_service.create_fl_round(
        db,
        round_number=body.round_number,
        num_clients=body.num_clients,
        aggregation_method=body.aggregation_method,
        he_scheme=body.he_scheme,
        he_poly_modulus=body.he_poly_modulus,
        duration_seconds=body.duration_seconds,
        global_loss=body.global_loss,
        global_accuracy=body.global_accuracy,
        global_f1=body.global_f1,
        global_precision=body.global_precision,
        global_recall=body.global_recall,
    )


# ── Client CRUD Endpoints ───────────────────────────────

@router.get("/clients", response_model=list[FLClientOut])
async def list_clients(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all registered FL clients."""
    return await fl_service.get_all_fl_clients(db)


@router.post("/clients", response_model=FLClientOut, status_code=201)
async def create_client(
    body: FLClientCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Register a new FL client."""
    return await fl_service.register_fl_client(
        db,
        client_id=body.client_id,
        name=body.name,
        data_path=body.data_path,
        description=body.description,
        ip_address=body.ip_address,
    )


@router.get("/clients/{client_pk}", response_model=FLClientDetailOut)
async def get_client(
    client_pk: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get a single FL client with its devices."""
    client = await fl_service.get_fl_client(db, client_pk)
    return client


@router.patch("/clients/{client_pk}", response_model=FLClientOut)
async def update_client(
    client_pk: int,
    body: FLClientUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Update an FL client."""
    return await fl_service.update_fl_client(
        db,
        client_pk,
        **body.model_dump(exclude_unset=True),
    )


@router.delete("/clients/{client_pk}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(
    client_pk: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Delete an FL client and all its devices."""
    await fl_service.delete_fl_client(db, client_pk)


@router.get("/clients/{client_pk}/devices", response_model=list[DeviceBriefOut])
async def list_client_devices(
    client_pk: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all devices belonging to a specific FL client."""
    # Verify client exists
    await fl_service.get_fl_client(db, client_pk)
    return await device_service.get_all_devices(db, client_id=client_pk)


# ── Container Management Endpoints ──────────────────────

class ContainerStatusOut(BaseModel):
    container_id: str | None = None
    name: str | None = None
    status: str  # created | running | paused | exited | dead | not_found
    image: str | None = None


@router.post(
    "/clients/{client_pk}/container/start",
    response_model=ContainerStatusOut,
)
async def start_client_container(
    client_pk: int,
    mode: str = "IDLE",
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Start the Docker container for an FL client.

    Query params:
        mode: IDLE | MONITOR | TRAIN (default: IDLE)

    If the container already exists it is recreated with the requested mode.
    """
    client = await fl_service.get_fl_client(db, client_pk)

    # Always (re-)create the container so the MODE env var is current
    try:
        if client.container_id:
            try:
                docker_service.remove_container(client.container_id, force=True)
            except Exception:
                pass  # container may already be gone

        info = docker_service.create_client_container(
            client_id=client.client_id,
            data_path=client.data_path,
            mode=mode,
            auto_start=True,
        )
        await fl_service.update_fl_client(
            db, client_pk,
            status="active",
            container_id=info.container_id,
            container_name=info.name,
        )
        return ContainerStatusOut(
            container_id=info.container_id,
            name=info.name,
            status=info.status,
            image=info.image,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to start container: {exc}",
        )


@router.post(
    "/clients/{client_pk}/container/stop",
    response_model=ContainerStatusOut,
)
async def stop_client_container(
    client_pk: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Stop the Docker container for an FL client."""
    client = await fl_service.get_fl_client(db, client_pk)
    if not client.container_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Client has no associated container.",
        )
    try:
        info = docker_service.stop_container(client.container_id)
        await fl_service.update_fl_client(db, client_pk, status="inactive")
        return ContainerStatusOut(
            container_id=info.container_id,
            name=info.name,
            status=info.status,
            image=info.image,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to stop container: {exc}",
        )


@router.get(
    "/clients/{client_pk}/container/status",
    response_model=ContainerStatusOut,
)
async def get_client_container_status(
    client_pk: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get the Docker container status for an FL client."""
    client = await fl_service.get_fl_client(db, client_pk)
    if not client.container_id:
        return ContainerStatusOut(status="not_found")

    info = docker_service.get_container_status(client.container_id)
    if info is None:
        return ContainerStatusOut(status="not_found")

    return ContainerStatusOut(
        container_id=info.container_id,
        name=info.name,
        status=info.status,
        image=info.image,
    )


# ── Training Session Management ────────────────────────

class FLStartRequest(BaseModel):
    """Configuration for a new FL training session."""
    num_rounds: int = Field(default=5, ge=1, le=100)
    min_clients: int = Field(default=2, ge=1)
    use_he: bool = True
    local_epochs: int = Field(default=3, ge=1)
    learning_rate: float = Field(default=0.001, gt=0.0)
    client_ids: Optional[List[str]] = Field(
        default=None,
        description="Specific client IDs to use for training. If None, all trainable clients are used.",
    )


class FLStartResponse(BaseModel):
    status: str
    message: str
    num_rounds: int
    num_clients: int
    client_ids: list[str] = []


class FLStopResponse(BaseModel):
    status: str
    message: str


@router.post("/start", response_model=FLStartResponse)
async def start_training(
    body: FLStartRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Start an FL training session.

    1. Validates that enough clients have training data
    2. Starts the FL server container FIRST (gRPC must be ready)
    3. Starts client containers in TRAIN mode
    4. Broadcasts training_start via WebSocket
    """
    import asyncio

    # Get all registered clients
    clients = await fl_service.get_all_fl_clients(db)

    # Filter by user-selected client_ids if provided
    if body.client_ids:
        selected_set = set(cid.lower() for cid in body.client_ids)
        clients = [c for c in clients if c.client_id.lower() in selected_set]
        if len(clients) < body.min_clients:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Selected {len(clients)} clients, but need at least {body.min_clients}",
            )

    if len(clients) < body.min_clients:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Need at least {body.min_clients} clients, but only {len(clients)} registered",
        )

    # Pre-validate: only include clients whose data directory has .npy files
    trainable_clients = []
    for client in clients:
        has_data = docker_service.validate_client_data(client.client_id)
        if has_data:
            trainable_clients.append(client)
        else:
            log.warning(
                "Client %s has no training data (data/clients/%s) — skipping",
                client.client_id, client.client_id.lower(),
            )

    if len(trainable_clients) < body.min_clients:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Need at least {body.min_clients} clients with training data, "
                f"but only {len(trainable_clients)} have data. "
                f"Ensure data/clients/<client_id>/ has X_seq_chunk_*.npy files."
            ),
        )

    # ── Step 1: Start FL server FIRST so gRPC is ready ──
    try:
        docker_service.start_fl_server(
            num_rounds=body.num_rounds,
            min_clients=min(body.min_clients, len(trainable_clients)),
            use_he=body.use_he,
        )
        log.info("FL server started: rounds=%d, clients=%d", body.num_rounds, len(trainable_clients))
    except Exception as exc:
        log.error("Failed to start FL server: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to start FL server: {exc}",
        )

    # Wait for the FL server gRPC to be ready (server needs ~2-3s to initialise)
    await asyncio.sleep(5)

    # ── Step 2: Start client containers in TRAIN mode ──
    active_client_ids = []
    for client in trainable_clients:
        try:
            # Remove existing container if any
            if client.container_id:
                try:
                    docker_service.remove_container(client.container_id, force=True)
                except Exception:
                    pass

            # Create and start in TRAIN mode
            info = docker_service.create_client_container(
                client_id=client.client_id,
                data_path=client.data_path,
                mode="TRAIN",
                auto_start=True,
            )
            await fl_service.update_fl_client(
                db, client.id,
                status="training",
                container_id=info.container_id,
                container_name=info.name,
            )
            active_client_ids.append(client.client_id)
            log.info("Started client %s in TRAIN mode", client.client_id)

        except Exception as exc:
            log.error("Failed to start client %s: %s", client.client_id, exc)

    if len(active_client_ids) < body.min_clients:
        # Clean up: stop the FL server since not enough clients started
        try:
            docker_service.stop_fl_server()
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Only {len(active_client_ids)} clients started, need {body.min_clients}",
        )

    # ── Step 3: Broadcast training start via WebSocket ──
    await ws_manager.broadcast(build_ws_message(WSMessageType.TRAINING_START, {
        "num_rounds": body.num_rounds,
        "num_clients": len(active_client_ids),
        "client_ids": active_client_ids,
        "use_he": body.use_he,
    }))

    return FLStartResponse(
        status="started",
        message=f"FL training started: {body.num_rounds} rounds, {len(active_client_ids)} clients",
        num_rounds=body.num_rounds,
        num_clients=len(active_client_ids),
        client_ids=active_client_ids,
    )


@router.post("/stop", response_model=FLStopResponse)
async def stop_training(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Stop an ongoing FL training session.

    1. Stops the FL server container
    2. Switches all training client containers to IDLE mode
    3. Broadcasts training_complete via WebSocket
    """
    # Stop FL server
    try:
        docker_service.stop_fl_server()
        log.info("FL server stopped")
    except Exception as exc:
        log.warning("Failed to stop FL server: %s", exc)

    # Switch all training clients back to IDLE
    clients = await fl_service.get_all_fl_clients(db)
    for client in clients:
        if client.status == "training" and client.container_id:
            try:
                docker_service.stop_container(client.container_id)
                await fl_service.update_fl_client(db, client.id, status="inactive")
            except Exception as exc:
                log.warning("Failed to stop client %s: %s", client.client_id, exc)

    # Broadcast training stop
    await ws_manager.broadcast(build_ws_message(WSMessageType.TRAINING_STOP, {
        "status": "stopped",
        "message": "FL training session stopped by user",
    }))

    return FLStopResponse(
        status="stopped",
        message="FL training session stopped",
    )
