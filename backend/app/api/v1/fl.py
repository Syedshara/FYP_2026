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

from sqlalchemy import select

from app.core.dependencies import get_db, get_current_user
from app.models.fl import SecurityEventLog, FLRound
from app.services import fl_service, device_service, docker_service, data_service
from app.services import workspace_service
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
    canvas_node_id: Optional[str] = None
    data_source: str = "cic-ids2017"
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
    canvas_node_id: Optional[str] = Field(default=None, max_length=100)
    data_source: str = Field(
        default="cic-ids2017", description="'cic-ids2017' or 'synthetic'"
    )


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
    all_clients = await fl_service.get_all_fl_clients(db)
    # Count clients that are active or currently training
    active_count = sum(1 for c in all_clients if c.status in ("active", "training"))

    return FLStatusResponse(
        is_training=any(c.status == "training" for c in all_clients),
        current_round=rounds[-1].round_number if rounds else None,
        total_rounds=len(rounds),
        active_clients=active_count,
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
        canvas_node_id=body.canvas_node_id,
        data_source=body.data_source,
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
            db,
            client_pk,
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
    min_clients: int = Field(default=1, ge=1)
    use_he: bool = False  # Default off — HE is computationally heavy on dev machines
    local_epochs: int = Field(default=5, ge=1, le=50)
    learning_rate: float = Field(default=0.001, gt=0.0)
    max_batches: int = Field(
        default=0,
        ge=0,
        description="Max batches per epoch per client. 0 = no cap (use all data).",
    )
    workspace_id: Optional[int] = Field(
        default=None, description="Workspace ID for topology lookup"
    )
    # Canvas-aware: list of canvas node IDs of Client nodes connected to this FL Server
    canvas_node_ids: Optional[List[str]] = Field(
        default=None,
        description="Canvas node IDs of Client nodes to include in training. "
        "If provided, only those clients are used.",
    )
    # Legacy: direct client_id list (lower priority than canvas_node_ids)
    client_ids: Optional[List[str]] = Field(
        default=None,
        description="Specific client_id strings. Used if canvas_node_ids is not provided.",
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

    # Canvas-aware filtering: canvas_node_ids takes priority over client_ids
    if body.canvas_node_ids:
        canvas_id_set = set(body.canvas_node_ids)

        # Auto-register any canvas nodes not yet in DB (eliminates race with background task)
        for canvas_node_id in body.canvas_node_ids:
            existing = await fl_service.get_fl_client_by_canvas_node_id(
                db, canvas_node_id
            )
            if not existing:
                derived_client_id = canvas_node_id.replace("-", "_")
                existing_by_id = await fl_service.get_fl_client_by_client_id(
                    db, derived_client_id
                )
                if not existing_by_id:
                    try:
                        await fl_service.register_fl_client(
                            db,
                            client_id=derived_client_id,
                            name=derived_client_id,
                            canvas_node_id=canvas_node_id,
                            data_source="cic-ids2017",
                            skip_data_generation=True,
                        )
                        log.info(
                            "On-demand registered canvas client %s as FL client %s",
                            canvas_node_id,
                            derived_client_id,
                        )
                    except Exception as exc:
                        log.warning(
                            "On-demand registration failed for %s: %s",
                            canvas_node_id,
                            exc,
                        )

        # Re-fetch all clients after potential auto-registration
        clients = await fl_service.get_all_fl_clients(db)
        clients = [c for c in clients if c.canvas_node_id in canvas_id_set]
        if not clients:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "No registered FL clients found for the provided canvas node IDs. "
                    "Canvas IDs: " + ", ".join(body.canvas_node_ids)
                ),
            )
    elif body.client_ids:
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

    # ── Generate training data based on Traffic Source topology ──
    # Look up workspace to find each client's Traffic Source config
    traffic_config: dict[
        str, tuple[str, str]
    ] = {}  # canvas_node_id → (data_source, traffic_type)
    if body.workspace_id:
        ws = await workspace_service.get_workspace(db, body.workspace_id)
        if ws:
            node_map = {n.node_key: n for n in ws.nodes}
            edge_list = ws.edges
            for client in clients:
                cnid = client.canvas_node_id
                if not cnid:
                    continue
                # Traverse: Client → (ownership) → Device → (traffic-feed) ← Traffic Source
                for edge in edge_list:
                    if edge.source_key == cnid and edge.edge_type == "ownership":
                        device_key = edge.target_key
                        for e2 in edge_list:
                            if (
                                e2.target_key == device_key
                                and e2.edge_type == "traffic-feed"
                            ):
                                ts_node = node_map.get(e2.source_key)
                                if ts_node and ts_node.node_type == "traffic-source":
                                    ts_data = ts_node.data or {}
                                    ds = ts_data.get("dataSource", "cic-ids2017")
                                    tt = ts_data.get("trafficType", "mixed")
                                    traffic_config[cnid] = (ds, tt)
                                    break
                        if cnid in traffic_config:
                            break

    # Broadcast data preparation phase
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.FL_PROGRESS,
            {
                "phase": "data_preparation",
                "message": f"Preparing training data for {len(clients)} client(s)...",
            },
        )
    )

    # Generate/regenerate training data for each client based on Traffic Source config
    for client in clients:
        ds, tt = traffic_config.get(
            client.canvas_node_id or "", ("cic-ids2017", "mixed")
        )
        log.info("Generating data for %s: source=%s, type=%s", client.client_id, ds, tt)
        data_info = data_service.generate_client_data(
            client.client_id,
            data_source=ds,
            traffic_type=tt,
            force=True,  # Always regenerate fresh from Traffic Source config
        )
        if data_info.get("created"):
            total = data_info.get("total_samples", 0)
            await fl_service.update_fl_client(
                db,
                client.id,
                total_samples=total,
                data_source=ds,
            )
            log.info("  → %d samples generated for %s", total, client.client_id)

    # Pre-validate: only include clients whose data directory has .npy files
    trainable_clients = []
    for client in clients:
        has_data = docker_service.validate_client_data(client.client_id)
        if has_data:
            trainable_clients.append(client)
        else:
            log.warning(
                "Client %s has no training data after generation — skipping",
                client.client_id,
            )

    if len(trainable_clients) < body.min_clients:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Need at least {body.min_clients} clients with training data, "
                f"but only {len(trainable_clients)} have data."
            ),
        )

    # ── Step 0: Clear previous training session data for clean slate ──
    deleted = await fl_service.delete_fl_round_data(db)
    if deleted:
        log.info(
            "Cleared %d old round/metric records before new training session", deleted
        )

    # ── Step 1: Start FL server FIRST so gRPC is ready ──
    client_names = [c.client_id for c in trainable_clients]
    try:
        docker_service.start_fl_server(
            num_rounds=body.num_rounds,
            min_clients=min(body.min_clients, len(trainable_clients)),
            use_he=body.use_he,
            local_epochs=body.local_epochs,
            learning_rate=body.learning_rate,
            max_batches=body.max_batches,
            client_names=client_names,
        )
        log.info(
            "FL server started: rounds=%d, clients=%d",
            body.num_rounds,
            len(trainable_clients),
        )
    except Exception as exc:
        log.error("Failed to start FL server: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to start FL server: {exc}",
        )

    # Wait for the FL server gRPC to be ready — poll up to 15s instead of a blind sleep
    server_ready = False
    for _ in range(15):
        await asyncio.sleep(1)
        info = docker_service.get_container_status(docker_service.FL_SERVER_CONTAINER)
        if info and info.status == "running":
            server_ready = True
            break
        if info and info.status in ("exited", "dead"):
            log.error("FL server container exited prematurely (status=%s)", info.status)
            break

    if not server_ready:
        docker_service.stop_fl_server()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="FL server container failed to reach running state within 15s",
        )

    # Give the Flower gRPC server a moment to bind its port after the container
    # reports "running" — the process is up but the listener may not be ready yet.
    await asyncio.sleep(2)
    # Persistent containers are never destroyed — update_client_container_mode
    # stops the current container and restarts it with MODE=TRAIN.
    active_client_ids = []
    for client in trainable_clients:
        try:
            info = docker_service.update_client_container_mode(
                client_id=client.client_id,
                data_path=client.data_path,
                new_mode="TRAIN",
            )
            await fl_service.update_fl_client(
                db,
                client.id,
                status="training",
                container_id=info.container_id,
                container_name=info.name,
            )
            active_client_ids.append(client.client_id)
            log.info("Switched client %s to TRAIN mode", client.client_id)

        except Exception as exc:
            log.error(
                "Failed to switch client %s to TRAIN mode: %s", client.client_id, exc
            )

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
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.TRAINING_START,
            {
                "num_rounds": body.num_rounds,
                "num_clients": len(active_client_ids),
                "client_ids": active_client_ids,
                "use_he": body.use_he,
            },
        )
    )

    return FLStartResponse(
        status="started",
        message=f"FL training started: {body.num_rounds} rounds, {len(active_client_ids)} clients",
        num_rounds=body.num_rounds,
        num_clients=len(active_client_ids),
        client_ids=active_client_ids,
    )


# ── Detection / Trust Endpoints (called by FL server) ──


class FlaggedClientBody(BaseModel):
    """Payload from FL server when a client is flagged as anomalous."""

    client_id: str
    round: int
    abnormality: float


class TrustScoreComponents(BaseModel):
    """Per-client abnormality breakdown from RECESS."""

    abnormality: float
    direction_score: float
    magnitude_score: float


class DetectionRoundBody(BaseModel):
    """Payload from FL server when a detection round completes."""

    round: int
    scores: dict[str, float]
    flagged: list[str]
    components: dict[str, TrustScoreComponents] = {}


@router.post("/flagged_client")
async def post_flagged_client(body: FlaggedClientBody):
    """
    Record a flagged client.
    Called by the FL server when a client's behaviour is anomalous.
    No auth required (internal service-to-service call).
    """
    fl_service.record_flagged_client(
        client_id=body.client_id,
        round_number=body.round,
        abnormality=body.abnormality,
    )
    timestamp = datetime.utcnow().isoformat() + "Z"
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.CLIENT_FLAGGED,
            {
                "client_id": body.client_id,
                "round": body.round,
                "abnormality": body.abnormality,
                "timestamp": timestamp,
            },
        )
    )
    return {"ok": True}


@router.post("/detection_round")
async def post_detection_round(
    body: DetectionRoundBody,
    db: AsyncSession = Depends(get_db),
):
    """
    Record a completed detection round and update trust scores.
    Called by the FL server after each RECESS anomaly-detection pass.
    No auth required (internal service-to-service call).
    """
    fl_service.record_detection_round(
        round_number=body.round,
        scores=body.scores,
        flagged=body.flagged,
    )
    fl_service.update_trust_scores(body.scores)
    # Persist updated scores so they survive a backend restart
    await fl_service.save_trust_scores_to_db(db)
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.CLIENT_TRUST_UPDATE,
            {
                "round": body.round,
                "scores": body.scores,
                "flagged": body.flagged,
                "components": {
                    cid: c.model_dump() for cid, c in body.components.items()
                },
            },
        )
    )
    return {"ok": True}


@router.get("/trust_scores")
async def get_trust_scores(_user=Depends(get_current_user)):
    """Return the current in-memory trust scores for all FL clients."""
    return {"trust_scores": fl_service.get_trust_scores()}


@router.post("/trust_scores/reset")
async def reset_trust_scores(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Reset all client trust scores to 1.0 in DB and memory.

    JWT-protected — intended for use via the FLSecurityPanel Reset button.
    Useful before a fresh experiment to avoid stale historical scores
    influencing RECESS detection.
    """
    await fl_service.reset_all_trust_scores(db)
    fl_service.reset_detection_history()
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.CLIENT_TRUST_UPDATE,
            {
                "scores": fl_service.get_trust_scores(),
                "reset": True,
            },
        )
    )
    return {"status": "ok", "message": "All trust scores reset to 1.0"}


@router.get("/detection_rounds")
async def get_detection_rounds(_user=Depends(get_current_user)):
    """Return the full history of detection rounds."""
    return {"rounds": fl_service.get_detection_rounds()}


@router.get("/flagged_clients")
async def get_flagged_clients(_user=Depends(get_current_user)):
    """Return the full history of flagged client events."""
    return {"flagged": fl_service.get_flagged_clients()}


# ── Aggregation Enforcement Endpoints ───────────────────


class AggregationEnforcementBody(BaseModel):
    """Payload sent by the FL server after each aggregation round."""

    round: int
    enforcement: dict[str, str]  # client_id → 'included'|'downweighted'|'excluded'
    excluded_count: int = 0
    downweighted_count: int = 0


@router.post("/aggregation_enforcement")
async def post_aggregation_enforcement(body: AggregationEnforcementBody):
    """
    Record per-client enforcement decisions for an aggregation round.
    Called by the FL server after trust-weighted aggregation.
    No auth required (internal service-to-service call).
    """
    fl_service.update_enforcement_status(body.enforcement)
    fl_service.record_enforcement_round(
        round_number=body.round,
        enforcement=body.enforcement,
        excluded_count=body.excluded_count,
        downweighted_count=body.downweighted_count,
    )
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.AGGREGATION_ENFORCEMENT,
            {
                "round": body.round,
                "enforcement": body.enforcement,
                "excluded_count": body.excluded_count,
                "downweighted_count": body.downweighted_count,
            },
        )
    )
    return {"ok": True}


@router.get("/enforcement_status")
async def get_enforcement_status(_user=Depends(get_current_user)):
    """Return the current per-client enforcement status and full history."""
    return {
        "enforcement": fl_service.get_enforcement_status(),
        "rounds": fl_service.get_enforcement_rounds(),
    }


@router.get("/security-events")
async def get_security_events(
    limit: int = 500,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Return persisted security pipeline events from the audit log.

    Used to hydrate the Watcher drill-down on first open so the Events
    pipeline tab shows history even if WebSocket messages were missed.
    Events are returned oldest-first so the frontend can replay them in order.
    """
    result = await db.execute(
        select(SecurityEventLog)
        .order_by(SecurityEventLog.created_at.asc())
        .limit(limit)
    )
    events = result.scalars().all()
    return {
        "events": [
            {
                "id": e.id,
                "round": e.round,
                "kind": e.kind,
                "client_id": e.client_id,
                "detail": e.detail,
                "data": e.data or {},
                "timestamp": e.created_at.isoformat() if e.created_at else None,
            }
            for e in events
        ]
    }


@router.get("/round-results")
async def get_round_results(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Return persisted FL round results with gradient stats and client metrics.

    Used to hydrate flRoundResults on Watcher mount so the Events pipeline tab
    shows full Client Training metrics, Dispatch norms, and Model Update deltas
    even after a page refresh (when live WS data has been lost).
    """
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(FLRound)
        .options(selectinload(FLRound.client_metrics))
        .order_by(FLRound.round_number.asc())
    )
    rounds = result.scalars().all()
    return {
        "rounds": [
            {
                "round": r.round_number,
                "loss": r.global_loss,
                "accuracy": r.global_accuracy,
                "gradient_stats": (r.security_data or {}).get("gradient_stats"),
                "client_metrics": [
                    {
                        "client_id": cm.client_id,
                        "local_loss": cm.local_loss,
                        "local_accuracy": cm.local_accuracy,
                        "num_samples": cm.num_samples,
                    }
                    for cm in r.client_metrics
                ]
                if r.client_metrics
                else None,
            }
            for r in rounds
        ]
    }


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

    # Switch all training clients back to IDLE mode
    # Persistent containers are never destroyed — update_client_container_mode
    # stops TRAIN and restarts in IDLE so the container slot lives on.
    clients = await fl_service.get_all_fl_clients(db)
    for client in clients:
        if client.status == "training":
            try:
                info = docker_service.update_client_container_mode(
                    client_id=client.client_id,
                    data_path=client.data_path,
                    new_mode="IDLE",
                )
                await fl_service.update_fl_client(
                    db,
                    client.id,
                    status="active",
                    container_id=info.container_id,
                    container_name=info.name,
                )
                log.info("Switched client %s back to IDLE mode", client.client_id)
            except Exception as exc:
                log.warning(
                    "Failed to switch client %s to IDLE: %s", client.client_id, exc
                )

    # Broadcast training stop
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.TRAINING_STOP,
            {
                "status": "stopped",
                "message": "FL training session stopped by user",
            },
        )
    )

    return FLStopResponse(
        status="stopped",
        message="FL training session stopped",
    )


# ── Poison Mode Toggle ──────────────────────────────────────


class PoisonToggleRequest(BaseModel):
    """Toggle gradient poisoning on a running FL client."""

    strategy: str = Field(
        default="none",
        description=(
            "Poison strategy: 'direction_flip', 'scale_attack', 'noise_inject', or 'none' to disable."
        ),
    )


class PoisonToggleResponse(BaseModel):
    client_id: str
    strategy: str
    active: bool
    message: str


@router.post(
    "/clients/{client_db_id}/poison",
    response_model=PoisonToggleResponse,
)
async def toggle_poison_mode(
    client_db_id: int,
    req: PoisonToggleRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Toggle gradient poisoning on a running FL client container.

    Writes a signal file to the shared volume that the FL client reads
    at the start of each training round.  No container restart required.

    Strategies:
      - direction_flip: reverses gradient direction + amplifies 1.5-3x
      - scale_attack: amplifies gradients by 5-10x
      - noise_inject: replaces gradients with random noise
      - none: disables poisoning (removes signal file)
    """
    VALID_STRATEGIES = {"direction_flip", "scale_attack", "noise_inject", "none"}
    if req.strategy not in VALID_STRATEGIES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid strategy '{req.strategy}'. Must be one of: {VALID_STRATEGIES}",
        )

    client = await fl_service.get_fl_client(db, client_db_id)
    if client is None:
        raise HTTPException(status_code=404, detail="FL client not found")

    # Write signal file inside the FL client container via Docker exec.
    # The fl_client/ directory is bind-mounted as /app in the container,
    # so writing /app/.poison_mode is visible to the client process immediately.
    container_name = client.container_name
    if not container_name:
        raise HTTPException(
            status_code=400,
            detail=f"Client {client.client_id} has no associated container",
        )

    try:
        container = docker_service.get_container_by_name(container_name)
        if container is None:
            raise HTTPException(
                status_code=400,
                detail=f"Container {container_name} not found",
            )

        if req.strategy == "none":
            container.exec_run(["rm", "-f", "/app/.poison_mode"])
            log.info("Poison mode disabled for client %s", client.client_id)
        else:
            container.exec_run(
                ["sh", "-c", f"echo -n '{req.strategy}' > /app/.poison_mode"]
            )
            log.warning(
                "POISON MODE ENABLED for client %s: strategy=%s",
                client.client_id,
                req.strategy,
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to write poison signal via Docker exec: {exc}",
        )

    # Broadcast a security event so the Watcher/Timeline can show it
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.SECURITY_EVENT,
            {
                "kind": "poison_toggle",
                "round": 0,
                "client_id": client.client_id,
                "detail": f"Poison {'activated' if req.strategy != 'none' else 'deactivated'}: {req.strategy}",
                "data": {"strategy": req.strategy, "active": req.strategy != "none"},
            },
        )
    )

    return PoisonToggleResponse(
        client_id=client.client_id,
        strategy=req.strategy,
        active=req.strategy != "none",
        message=f"Poison mode {'activated' if req.strategy != 'none' else 'deactivated'} for {client.client_id}",
    )
