"""
FL Training API endpoints.

- GET  /rounds          — list all FL rounds
- GET  /rounds/{n}      — get specific round + client metrics
- GET  /status          — current training status
- GET  /clients         — list registered FL clients
- POST /clients         — register a new FL client
- POST /rounds          — record a completed round (called by FL server)
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_db, get_current_user
from app.services import fl_service

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


class FLClientOut(BaseModel):
    id: int
    client_id: str
    status: str
    data_path: str
    container_id: Optional[str] = None
    model_config = {"from_attributes": True}


class FLClientCreate(BaseModel):
    client_id: str = Field(..., min_length=1, max_length=50)
    data_path: str = Field(default="/app/data")


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


# ── Endpoints ────────────────────────────────────────────

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


@router.get("/clients", response_model=list[FLClientOut])
async def list_clients(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all registered FL clients."""
    return await fl_service.get_all_fl_clients(db)


@router.post("/clients", response_model=FLClientOut, status_code=201)
async def register_client(
    body: FLClientCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Register a new FL client."""
    return await fl_service.register_fl_client(db, body.client_id, body.data_path)


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
