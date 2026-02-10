"""
Prediction / Inference API endpoints.

- POST /predict          — run inference on a single sequence
- POST /predict/batch    — run inference on a batch of sequences
- GET  /model            — get loaded model info
- GET  /summary          — prediction statistics for dashboard
- GET  /device/{id}      — prediction history for a device
"""

from datetime import datetime
from typing import Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_db, get_current_user
from app.services import prediction_service

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────

class PredictRequest(BaseModel):
    """Single sequence prediction request."""
    device_id: UUID
    features: List[List[float]] = Field(
        ...,
        description="Sequence of 10 feature vectors, each with 78 floats",
        min_length=10,
        max_length=10,
    )
    window_start_idx: Optional[int] = None
    window_end_idx: Optional[int] = None


class PredictBatchRequest(BaseModel):
    """Batch prediction request."""
    device_id: UUID
    sequences: List[List[List[float]]] = Field(
        ...,
        description="List of sequences, each (10, 78)",
        min_length=1,
        max_length=256,
    )


class PredictResult(BaseModel):
    score: float
    label: str
    confidence: float
    inference_latency_ms: float
    model_version: str


class PredictResponse(BaseModel):
    prediction: PredictResult
    saved: bool = False
    prediction_id: Optional[int] = None


class BatchPredictResponse(BaseModel):
    predictions: List[PredictResult]
    count: int
    saved: bool = False


class ModelInfoResponse(BaseModel):
    loaded: bool
    version: Optional[str] = None
    path: Optional[str] = None
    architecture: str
    input_shape: str
    threshold: float


class PredictionOut(BaseModel):
    id: int
    device_id: UUID
    client_id: Optional[int] = None
    score: float
    label: str
    confidence: float
    attack_type: Optional[str] = None
    model_version: str
    inference_latency_ms: float
    timestamp: datetime
    model_config = {"from_attributes": True}


class PredictionSummaryResponse(BaseModel):
    total_predictions: int
    attack_count: int
    benign_count: int
    attack_rate: float
    avg_confidence: float
    avg_latency_ms: float


# ── Endpoints ────────────────────────────────────────────

@router.post("/predict", response_model=PredictResponse)
async def predict(
    body: PredictRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Run inference on a single traffic sequence (10 timesteps × 78 features).
    Returns prediction and saves to database.
    """
    try:
        result = prediction_service.run_inference(body.features)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # Save to database
    try:
        pred = await prediction_service.save_prediction(
            db,
            device_id=body.device_id,
            result=result,
            window_start_idx=body.window_start_idx,
            window_end_idx=body.window_end_idx,
        )
        return PredictResponse(
            prediction=PredictResult(**result),
            saved=True,
            prediction_id=pred.id,
        )
    except Exception:
        # Return prediction even if DB save fails
        return PredictResponse(
            prediction=PredictResult(**result),
            saved=False,
        )


@router.post("/predict/batch", response_model=BatchPredictResponse)
async def predict_batch(
    body: PredictBatchRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Run batch inference on multiple sequences.
    """
    try:
        results = prediction_service.run_batch_inference(body.sequences)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # Save all predictions to database
    saved = True
    try:
        for result in results:
            await prediction_service.save_prediction(
                db, device_id=body.device_id, result=result,
            )
    except Exception:
        saved = False

    return BatchPredictResponse(
        predictions=[PredictResult(**r) for r in results],
        count=len(results),
        saved=saved,
    )


@router.get("/model", response_model=ModelInfoResponse)
async def model_info(_user=Depends(get_current_user)):
    """Get information about the loaded ML model."""
    # Attempt to load model if not already loaded
    prediction_service.load_model()
    info = prediction_service.get_model_info()
    return ModelInfoResponse(**info)


@router.get("/summary", response_model=PredictionSummaryResponse)
async def prediction_summary(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get aggregate prediction statistics for the dashboard."""
    summary = await prediction_service.get_prediction_summary(db)
    return PredictionSummaryResponse(**summary)


@router.get("/device/{device_id}", response_model=list[PredictionOut])
async def device_predictions(
    device_id: UUID,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get recent prediction history for a specific device."""
    preds = await prediction_service.get_predictions_for_device(db, device_id, limit)
    return preds
