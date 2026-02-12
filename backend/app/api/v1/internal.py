"""
Internal API endpoints — service-to-service (no JWT auth).

These are called by FL client/server containers running on the same Docker network.
They are NOT exposed to the frontend.

- GET  /client/by-client-id/{client_id}  — resolve client_id string → DB record
- POST /client/register                  — auto-register a new FL client
- GET  /client/{pk}/devices              — list devices for a client
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
from app.core.websocket import ws_manager, WSMessageType, build_ws_message

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
            create_container=False,       # We ARE the container
        )
        return client
    except ConflictException:
        raise HTTPException(status_code=409, detail=f"Client '{body.client_id}' already exists")


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

    # Look up device name for WS broadcast
    device_name: str | None = None
    try:
        dev = await device_service.get_device(db, body.device_id)
        device_name = dev.name
    except Exception:
        pass

    # Broadcast via WebSocket
    await ws_manager.broadcast(build_ws_message(WSMessageType.PREDICTION, {
        "id": pred.id,
        "device_id": str(pred.device_id),
        "device_name": device_name,
        "client_id": pred.client_id,
        "score": pred.score,
        "label": pred.label,
        "confidence": pred.confidence,
        "attack_type": pred.attack_type,
        "inference_latency_ms": pred.inference_latency_ms,
        "model_version": pred.model_version,
        "timestamp": pred.timestamp.isoformat() if pred.timestamp else None,
    }))

    # Update device status to "online" (or "under_attack" if attack detected)
    try:
        new_status = "under_attack" if (body.label == "attack" and body.confidence > 0.7) else "online"
        await device_service.update_device(db, body.device_id, status=new_status)

        # Broadcast device status change
        await ws_manager.broadcast(build_ws_message(WSMessageType.DEVICE_STATUS, {
            "device_id": str(body.device_id),
            "device_name": device_name,
            "status": new_status,
        }))
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
        body.client_id, body.round, body.phase, body.message or "",
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
    await ws_manager.broadcast(build_ws_message(WSMessageType.FL_ROUND, {
        "round_number": body.round_number,
        "total_rounds": body.total_rounds,
        "num_clients": body.num_clients,
        "aggregation_method": body.aggregation_method,
        "duration_seconds": body.duration_seconds,
        "global_loss": body.global_loss,
        "global_accuracy": body.global_accuracy,
        "client_metrics": client_data,
    }))

    log.info(
        "FL round %d/%d persisted (id=%d, clients=%d)",
        body.round_number, body.total_rounds, fl_round.id, body.num_clients,
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

    await ws_manager.broadcast(build_ws_message(msg_type, body.model_dump(exclude_none=True)))

    log.info("FL status: %s (rounds=%s)", body.status, body.total_rounds)
    return {"ok": True}
