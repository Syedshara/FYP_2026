"""
Internal API endpoints — service-to-service (no JWT auth).

These are called by FL client/server containers running on the same Docker network.
They are NOT exposed to the frontend.

- GET  /client/by-client-id/{client_id}  — resolve client_id string → DB record
- POST /client/register                  — auto-register a new FL client
- GET  /client/{pk}/devices              — list devices for a client
- POST /device/create                    — auto-create a virtual device for a client
- POST /predictions                      — save a prediction result
- POST /fl/progress                      — FL training progress update (broadcast via WS)
- POST /fl/round                         — completed round + per-client metrics
- POST /fl/status                        — training started/completed status
"""

from __future__ import annotations

import logging
from typing import Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_db
from app.services import fl_service, device_service
from app.services import attack_service
from app.core.websocket import ws_manager, WSMessageType, build_ws_message
from app.api.v1.attacks import stop_pipeline

log = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────


class InternalClientOut(BaseModel):
    id: int
    client_id: str
    name: str
    status: str
    model_config = {"from_attributes": True}


class InternalDeviceOut(BaseModel):
    id: UUID
    name: str
    device_type: str
    status: str
    model_config = {"from_attributes": True}


class InternalDeviceCreate(BaseModel):
    name: str
    device_type: str = "sensor"
    protocol: str = "tcp"
    port: int = 0
    traffic_source: str = "simulated"
    client_id: int
    description: Optional[str] = None


class InternalPredictionCreate(BaseModel):
    device_id: UUID
    client_id: int
    score: float
    label: str
    confidence: float
    inference_latency_ms: float
    model_version: str = "local"
    attack_type: Optional[str] = None


class InternalPredictionOut(BaseModel):
    id: int
    saved: bool = True


class FLProgressIn(BaseModel):
    """Progress update from FL client or server."""

    client_id: Optional[str] = None
    round: Optional[int] = None
    total_rounds: Optional[int] = None
    phase: str  # training | sending_weights | aggregating | encrypting
    epoch: Optional[int] = None
    total_epochs: Optional[int] = None
    epoch_loss: Optional[float] = None
    loss: Optional[float] = None
    num_samples: Optional[int] = None
    num_clients: Optional[int] = None
    training_time_sec: Optional[float] = None
    message: Optional[str] = None
    # ── Per-batch detailed progress (Task 4) ──
    batch: Optional[int] = None
    total_batches: Optional[int] = None
    batches_processed: Optional[int] = None
    grand_total_batches: Optional[int] = None
    samples_processed: Optional[int] = None
    total_samples: Optional[int] = None
    throughput: Optional[float] = None
    eta_seconds: Optional[float] = None
    current_loss: Optional[float] = None
    current_accuracy: Optional[float] = None
    local_accuracy: Optional[float] = None
    last_update_time: Optional[str] = None


class FLRoundIn(BaseModel):
    """Completed round from FL server."""

    round_number: int
    total_rounds: int
    num_clients: int
    aggregation_method: str = "fedavg_he"
    he_scheme: Optional[str] = "ckks"
    he_poly_modulus: Optional[int] = 16384
    duration_seconds: Optional[float] = None
    global_loss: Optional[float] = None
    global_accuracy: Optional[float] = None
    client_metrics: Optional[List[FLClientMetricIn]] = None
    # Per-layer gradient statistics computed from in-memory tensors (not persisted to DB)
    gradient_stats: Optional[dict] = None


class FLClientMetricIn(BaseModel):
    client_id: str
    local_loss: float
    local_accuracy: float = 0.0
    num_samples: int
    training_time_sec: float = 0.0
    encrypted: bool = True


# Forward-ref fix: rebuild FLRoundIn now that FLClientMetricIn is defined
FLRoundIn.model_rebuild()


class FLStatusIn(BaseModel):
    """Training session status change from FL server."""

    status: str  # started | completed | failed
    total_rounds: Optional[int] = None
    rounds_completed: Optional[int] = None
    num_clients: Optional[int] = None
    use_he: Optional[bool] = None
    model_path: Optional[str] = None


# ── Client / Device / Prediction endpoints ───────────────


@router.get("/client/by-client-id/{client_id}", response_model=InternalClientOut)
async def get_client_by_string_id(
    client_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Resolve a client_id string (e.g. 'bank_a') to its DB record."""
    client = await fl_service.get_fl_client_by_client_id(db, client_id)
    if not client:
        raise HTTPException(status_code=404, detail=f"Client '{client_id}' not found")
    return client


@router.get("/client/{client_pk}/devices", response_model=list[InternalDeviceOut])
async def list_client_devices(
    client_pk: int,
    db: AsyncSession = Depends(get_db),
):
    """List all devices belonging to a specific FL client (no auth)."""
    devices = await device_service.get_all_devices(db, client_id=client_pk)
    return devices


@router.post("/device/create", response_model=InternalDeviceOut, status_code=201)
async def internal_create_device(
    body: InternalDeviceCreate,
    db: AsyncSession = Depends(get_db),
):
    """
    Auto-create a virtual device linked to an FL client.
    Called by monitor containers when they find no devices registered.
    If a device with the same name already exists, returns it instead of erroring.
    """
    from app.core.exceptions import ConflictException

    try:
        device = await device_service.create_device(
            db,
            name=body.name,
            device_type=body.device_type,
            protocol=body.protocol,
            port=body.port,
            traffic_source=body.traffic_source,
            description=body.description,
            client_id=body.client_id,
        )
        log.info(
            "Auto-created virtual device '%s' for client_id=%d",
            body.name,
            body.client_id,
        )
        return device
    except ConflictException:
        # Device name already exists — fetch it and return the first match for this client
        existing = await device_service.get_all_devices(db, client_id=body.client_id)
        if existing:
            log.info(
                "Device '%s' already exists for client_id=%d — returning existing",
                body.name,
                body.client_id,
            )
            return existing[0]
        raise HTTPException(
            status_code=409,
            detail=f"Device name '{body.name}' already taken by another client",
        )


# ── Auto‑register client (called by monitor containers) ──


class InternalClientRegister(BaseModel):
    client_id: str
    name: str
    description: Optional[str] = None


@router.post("/client/register", response_model=InternalClientOut, status_code=201)
async def register_client_internal(
    body: InternalClientRegister,
    db: AsyncSession = Depends(get_db),
):
    """
    Auto‑register a new FL client from inside a simulation container.
    If the client already exists, returns 409.
    No Docker container is created (the caller IS the container).
    """
    from app.core.exceptions import ConflictException

    try:
        client = await fl_service.register_fl_client(
            db,
            client_id=body.client_id,
            name=body.name,
            description=body.description,
            create_container=False,  # We ARE the container
        )
    except ConflictException:
        raise HTTPException(
            status_code=409, detail=f"Client '{body.client_id}' already exists"
        )

    # Auto-create a default Device linked to this client so that monitor mode
    # finds at least one device immediately without requiring manual registration.
    try:
        await device_service.create_device(
            db,
            name=f"{body.name} Sensor 1",
            device_type="sensor",
            protocol="tcp",
            port=0,
            traffic_source="simulated",
            description=f"Auto-created device for FL client '{body.client_id}'",
            client_id=client.id,
        )
        log.info(
            "Auto-created device for FL client '%s' (db_id=%d)",
            body.client_id,
            client.id,
        )
    except Exception as exc:
        # Non-fatal: client is registered; device creation is best-effort.
        # On duplicate name (e.g. if register is retried) this is harmless.
        log.warning(
            "Could not auto-create device for client '%s': %s", body.client_id, exc
        )

    return client


@router.post("/predictions", response_model=InternalPredictionOut, status_code=201)
async def save_prediction(
    body: InternalPredictionCreate,
    db: AsyncSession = Depends(get_db),
):
    """
    Save a prediction result from an FL client container.
    Also broadcasts the prediction via WebSocket.
    """
    from app.models.prediction import Prediction

    pred = Prediction(
        device_id=body.device_id,
        client_id=body.client_id,
        score=body.score,
        label=body.label,
        confidence=body.confidence,
        inference_latency_ms=body.inference_latency_ms,
        model_version=body.model_version,
        attack_type=body.attack_type,
    )
    db.add(pred)
    await db.commit()
    await db.refresh(pred)

    # Look up device name + owning FL client string ID for WS broadcast
    device_name: str | None = None
    client_string_id: str | None = None
    try:
        from sqlalchemy import select as sa_select
        from app.models.device import Device
        from app.models.fl import FLClient

        result = await db.execute(
            sa_select(Device.name, FLClient.client_id)
            .outerjoin(FLClient, Device.client_id == FLClient.id)
            .where(Device.id == body.device_id)
        )
        row = result.first()
        if row:
            device_name, client_string_id = row
    except Exception:
        pass

    # Broadcast via WebSocket
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.PREDICTION,
            {
                "id": pred.id,
                "device_id": str(pred.device_id),
                "device_name": device_name,
                "client_string_id": client_string_id,
                "client_id": pred.client_id,
                "score": pred.score,
                "label": pred.label,
                "confidence": pred.confidence,
                "attack_type": pred.attack_type,
                "inference_latency_ms": pred.inference_latency_ms,
                "model_version": pred.model_version,
                "timestamp": pred.timestamp.isoformat() if pred.timestamp else None,
            },
        )
    )

    # Update device status to "online" (or "under_attack" if attack detected)
    try:
        new_status = (
            "under_attack"
            if (body.label == "attack" and body.confidence > 0.7)
            else "online"
        )
        await device_service.update_device(db, body.device_id, status=new_status)

        # Broadcast device status change
        await ws_manager.broadcast(
            build_ws_message(
                WSMessageType.DEVICE_STATUS,
                {
                    "device_id": str(body.device_id),
                    "device_name": device_name,
                    "status": new_status,
                },
            )
        )
    except Exception as exc:
        log.warning("Failed to update device status for %s: %s", body.device_id, exc)

    return InternalPredictionOut(id=pred.id)


# ── FL Progress / Round / Status endpoints ───────────────


@router.post("/fl/progress", status_code=200)
async def fl_progress(body: FLProgressIn):
    """
    Receive training progress from FL client or server.
    Broadcasts immediately to all connected frontends via WebSocket.
    """
    data = body.model_dump(exclude_none=True)
    await ws_manager.broadcast(build_ws_message(WSMessageType.FL_PROGRESS, data))
    log.info(
        "FL progress: client=%s round=%s phase=%s %s",
        body.client_id,
        body.round,
        body.phase,
        body.message or "",
    )
    return {"ok": True}


@router.post("/fl/round", status_code=201)
async def fl_round_complete(
    body: FLRoundIn,
    db: AsyncSession = Depends(get_db),
):
    """
    Receive completed round data from FL server.
    Persists to database and broadcasts via WebSocket.
    """
    # Persist round
    fl_round = await fl_service.create_fl_round(
        db,
        round_number=body.round_number,
        num_clients=body.num_clients,
        aggregation_method=body.aggregation_method,
        he_scheme=body.he_scheme,
        he_poly_modulus=body.he_poly_modulus,
        duration_seconds=body.duration_seconds,
        global_loss=body.global_loss,
        global_accuracy=body.global_accuracy,
    )

    # Persist per-client metrics
    client_data = []
    if body.client_metrics:
        for cm in body.client_metrics:
            await fl_service.create_client_metric(
                db,
                round_id=fl_round.id,
                client_id=cm.client_id,
                local_loss=cm.local_loss,
                local_accuracy=cm.local_accuracy,
                num_samples=cm.num_samples,
                training_time_sec=cm.training_time_sec,
                encrypted=cm.encrypted,
            )
            client_data.append(cm.model_dump())

    # Broadcast round completion
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.FL_ROUND,
            {
                "round_number": body.round_number,
                "total_rounds": body.total_rounds,
                "num_clients": body.num_clients,
                "aggregation_method": body.aggregation_method,
                "duration_seconds": body.duration_seconds,
                "global_loss": body.global_loss,
                "global_accuracy": body.global_accuracy,
                "client_metrics": client_data,
                "gradient_stats": body.gradient_stats,
            },
        )
    )

    log.info(
        "FL round %d/%d persisted (id=%d, clients=%d)",
        body.round_number,
        body.total_rounds,
        fl_round.id,
        body.num_clients,
    )
    return {"ok": True, "round_id": fl_round.id}


@router.post("/fl/status", status_code=200)
async def fl_status_change(
    body: FLStatusIn,
    db: AsyncSession = Depends(get_db),
):
    """
    Training session status change from FL server.
    Broadcasts start/complete/failed events via WebSocket.
    When training completes, resets all 'training' clients back to 'active'.
    """
    if body.status == "started":
        msg_type = WSMessageType.TRAINING_START
        # Re-hydrate in-memory trust scores from DB so the new session inherits
        # any scores that were accumulated (and persisted) by prior sessions.
        await fl_service.load_trust_scores_from_db(db)
        log.info("Trust scores loaded from DB for new training session")
    elif body.status == "completed":
        msg_type = WSMessageType.TRAINING_STOP
    else:
        msg_type = WSMessageType.FL_PROGRESS

    # When training completes (or fails), reset client statuses
    if body.status in ("completed", "failed"):
        all_clients = await fl_service.get_all_fl_clients(db)
        for client in all_clients:
            if client.status == "training":
                await fl_service.update_fl_client(db, client.id, status="active")
                log.info("Client %s status: training → active", client.client_id)

    await ws_manager.broadcast(
        build_ws_message(msg_type, body.model_dump(exclude_none=True))
    )

    log.info("FL status: %s (rounds=%s)", body.status, body.total_rounds)
    return {"ok": True}


# ── Attack engine status callback ────────────────────────


class AttackRunStatusIn(BaseModel):
    """Status update from an attack engine container."""

    run_id: int
    status: str  # running | completed | failed | cancelled
    duration_seconds: Optional[float] = None
    packets_sent: Optional[int] = None
    packets_captured: Optional[int] = None
    detections: Optional[int] = None
    detection_rate: Optional[float] = None
    error_message: Optional[str] = None
    results: Optional[dict] = None


class SecurityEventIn(BaseModel):
    """Security pipeline event from FL server/client."""

    kind: str  # nonce_issued | nonce_verified | signature_verified | ...
    round: int
    client_id: Optional[str] = None
    detail: Optional[str] = None
    data: Optional[dict] = None  # structured metrics (HE timing, per-layer norms, etc.)


# ── FedRecovery internal schemas ─────────────────────────


class FedRecoveryStartedIn(BaseModel):
    """FL server notifies backend that a FedRecovery run has started."""

    run_id: str  # UUID string generated by FL server
    flagged_client_id: str
    flag_round: int


class FedRecoveryStepIn(BaseModel):
    """FL server reports a single correction step within a FedRecovery run."""

    run_id: str
    round: int
    step: str  # 'corrected' | 'skipped'
    detail: Optional[str] = None
    data: Optional[dict] = None  # per-round metrics (norms, noise sigma, etc.)


class FedRecoveryCompleteIn(BaseModel):
    """FL server reports final outcome of a FedRecovery run."""

    run_id: str
    status: str  # 'complete' | 'partial' | 'failed' | 'cancelled'
    rounds_corrected: Optional[int] = None
    rounds_skipped: Optional[int] = None
    before_norms: Optional[dict] = None
    after_norms: Optional[dict] = None
    epsilon: Optional[float] = None
    sigma: Optional[float] = None
    accuracy_before: Optional[float] = None
    accuracy_after: Optional[float] = None
    loss_before: Optional[float] = None
    loss_after: Optional[float] = None


@router.post("/attack-run-status", status_code=200)
async def attack_run_status(
    body: AttackRunStatusIn,
    db: AsyncSession = Depends(get_db),
):
    """
    Receive status update from an attack engine container.
    Updates the DB record and broadcasts via WebSocket.
    """
    finished = body.status in ("completed", "failed", "cancelled")

    # If the run reached a terminal state, stop its capture pipeline
    if finished:
        stop_pipeline(body.run_id)

    run = await attack_service.update_run_status(
        db,
        run_id=body.run_id,
        status=body.status,
        packets_sent=body.packets_sent,
        packets_captured=body.packets_captured,
        detections=body.detections,
        detection_rate=body.detection_rate,
        error_message=body.error_message,
        results=body.results,
        finished=finished,
    )

    if run is None:
        raise HTTPException(
            status_code=404, detail=f"Attack run {body.run_id} not found"
        )

    # Broadcast status change via WebSocket
    ws_type = WSMessageType.ATTACK_RESULT if finished else WSMessageType.ATTACK_STATUS
    await ws_manager.broadcast(
        build_ws_message(
            ws_type,
            {
                "run_id": run.id,
                "attack_id": run.attack_id,
                "status": run.status,
                "packets_sent": run.packets_sent,
                "duration_seconds": body.duration_seconds,
                "error_message": run.error_message,
                "results": body.results or {},
            },
        )
    )

    log.info(
        "Attack run %d status: %s (packets=%s)", run.id, run.status, run.packets_sent
    )
    return {"ok": True}


# ── Security event reporting ─────────────────────────────


@router.post("/fl/security-event", status_code=200)
async def fl_security_event(body: SecurityEventIn):
    """
    Receive a security pipeline event from FL server or client.
    Broadcasts immediately to all connected frontends via WebSocket.
    """
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.SECURITY_EVENT,
            {
                "kind": body.kind,
                "round": body.round,
                "client_id": body.client_id,
                "detail": body.detail,
                "data": body.data,
            },
        )
    )
    log.debug(
        "Security event: kind=%s round=%d client=%s",
        body.kind,
        body.round,
        body.client_id,
    )
    return {"ok": True}


@router.post("/fl/security-events-batch", status_code=200)
async def fl_security_events_batch(events: List[SecurityEventIn]):
    """
    Receive multiple security events in one call (reduces HTTP overhead
    during busy rounds).
    """
    for body in events:
        await ws_manager.broadcast(
            build_ws_message(
                WSMessageType.SECURITY_EVENT,
                {
                    "kind": body.kind,
                    "round": body.round,
                    "client_id": body.client_id,
                    "detail": body.detail,
                    "data": body.data,
                },
            )
        )
    log.debug("Security events batch: %d events", len(events))
    return {"ok": True, "count": len(events)}


@router.get("/fl/trust_scores")
async def get_fl_trust_scores_internal():
    """Return current in-memory trust scores for the FL server to fetch.

    No auth — protected by Docker network isolation (internal only).
    Called by the FL server at the start of round 1 to re-hydrate its own
    _trust_scores dict with scores persisted from previous training sessions.
    """
    return {"trust_scores": fl_service.get_trust_scores()}


# ── FedRecovery lifecycle endpoints ──────────────────────


@router.post("/fl/fedrecovery/started", status_code=201)
async def fl_fedrecovery_started(
    body: FedRecoveryStartedIn,
    db: AsyncSession = Depends(get_db),
):
    """FL server signals that a FedRecovery run has begun.

    Creates a FedRecoveryRun DB record and broadcasts a fedrecovery_event
    with kind='started' to all connected frontends.
    """
    run = await fl_service.create_fed_recovery_run(
        db,
        run_id=body.run_id,
        flagged_client_id=body.flagged_client_id,
        flag_round=body.flag_round,
    )
    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.FEDRECOVERY_EVENT,
            {
                "kind": "started",
                "run_id": body.run_id,
                "flagged_client_id": body.flagged_client_id,
                "flag_round": body.flag_round,
            },
        )
    )
    log.info(
        "FedRecovery started: run_id=%s client=%s flag_round=%d",
        body.run_id,
        body.flagged_client_id,
        body.flag_round,
    )
    return {"ok": True, "run_db_id": run.id}


@router.post("/fl/fedrecovery/step", status_code=200)
async def fl_fedrecovery_step(
    body: FedRecoveryStepIn,
    db: AsyncSession = Depends(get_db),
):
    """FL server reports completion of one correction step within a run.

    Appends the step to FedRecoveryRun.steps (crash-safe — each step is
    committed individually) and broadcasts a fedrecovery_event with
    kind='step' to all connected frontends.
    """
    run = await fl_service.append_fed_recovery_step(
        db,
        run_id=body.run_id,
        round_num=body.round,
        step=body.step,
        detail=body.detail,
        data=body.data,
    )
    if run is None:
        raise HTTPException(
            status_code=404, detail=f"FedRecovery run '{body.run_id}' not found"
        )

    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.FEDRECOVERY_EVENT,
            {
                "kind": "step",
                "run_id": body.run_id,
                "round": body.round,
                "step": body.step,
                "detail": body.detail,
                "data": body.data,
                "rounds_corrected": run.rounds_corrected,
                "rounds_skipped": run.rounds_skipped,
            },
        )
    )
    log.debug(
        "FedRecovery step: run_id=%s round=%d step=%s",
        body.run_id,
        body.round,
        body.step,
    )
    return {"ok": True}


@router.post("/fl/fedrecovery/complete", status_code=200)
async def fl_fedrecovery_complete(
    body: FedRecoveryCompleteIn,
    db: AsyncSession = Depends(get_db),
):
    """FL server reports the final outcome of a FedRecovery run.

    Updates the FedRecoveryRun record to a terminal status with all
    final metrics, and broadcasts a fedrecovery_event with kind equal
    to 'complete', 'partial', 'failed', or 'cancelled'.
    """
    run = await fl_service.complete_fed_recovery_run(
        db,
        run_id=body.run_id,
        status=body.status,
        rounds_corrected=body.rounds_corrected,
        rounds_skipped=body.rounds_skipped,
        before_norms=body.before_norms,
        after_norms=body.after_norms,
        epsilon=body.epsilon,
        sigma=body.sigma,
        accuracy_before=body.accuracy_before,
        accuracy_after=body.accuracy_after,
        loss_before=body.loss_before,
        loss_after=body.loss_after,
    )
    if run is None:
        raise HTTPException(
            status_code=404, detail=f"FedRecovery run '{body.run_id}' not found"
        )

    await ws_manager.broadcast(
        build_ws_message(
            WSMessageType.FEDRECOVERY_EVENT,
            {
                "kind": body.status,  # 'complete' | 'partial' | 'failed' | 'cancelled'
                "run_id": body.run_id,
                "flagged_client_id": run.flagged_client_id,
                "flag_round": run.flag_round,
                "rounds_corrected": run.rounds_corrected,
                "rounds_skipped": run.rounds_skipped,
                "before_norms": run.before_norms,
                "after_norms": run.after_norms,
                "epsilon": run.epsilon,
                "sigma": run.sigma,
                "accuracy_before": run.accuracy_before,
                "accuracy_after": run.accuracy_after,
                "loss_before": run.loss_before,
                "loss_after": run.loss_after,
                "completed_at": run.completed_at.isoformat()
                if run.completed_at
                else None,
            },
        )
    )
    log.info(
        "FedRecovery complete: run_id=%s status=%s corrected=%d skipped=%d",
        body.run_id,
        body.status,
        run.rounds_corrected or 0,
        run.rounds_skipped or 0,
    )
    return {"ok": True}
