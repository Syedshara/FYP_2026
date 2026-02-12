"""
Prediction / Inference service.

Loads the CNN-LSTM global model once and provides inference
for incoming traffic feature vectors.
"""

import time
import logging
from pathlib import Path
from typing import Optional
from uuid import UUID

import numpy as np
import torch

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.prediction import Prediction
from app.services.explainability import explain_prediction

log = logging.getLogger(__name__)

# ── Model singleton ──────────────────────────────────────

_model = None
_model_version: str = "unknown"
_device = torch.device("cpu")

# Model architecture constants (must match fl_common/model.py)
SEQ_LEN = 10
NUM_FEATURES = 78
THRESHOLD = 0.5


class CNN_LSTM_IDS(torch.nn.Module):
    """CNN-LSTM model (duplicated here to avoid fl_common dependency)."""

    def __init__(self, seq_len: int = SEQ_LEN, num_features: int = NUM_FEATURES):
        super().__init__()
        self.conv1 = torch.nn.Conv1d(num_features, 64, kernel_size=3, padding=1)
        self.relu = torch.nn.ReLU()
        self.lstm = torch.nn.LSTM(64, 64, num_layers=1, batch_first=True)
        self.fc = torch.nn.Linear(64, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x.permute(0, 2, 1)
        x = self.relu(self.conv1(x))
        x = x.permute(0, 2, 1)
        _, (h_n, _) = self.lstm(x)
        return self.fc(h_n[-1])


# ── Paths to search for model weights ──────────────────

MODEL_SEARCH_PATHS = [
    
    "/app/models/cnn_lstm_global_with_HE_25rounds_16k.pt",
]


def _find_model_path() -> Optional[str]:
    """Return the first available model file path."""
    for p in MODEL_SEARCH_PATHS:
        if Path(p).exists():
            return p
    return None


def load_model(force_reload: bool = False) -> bool:
    """
    Load the global model weights.
    Returns True if model is ready for inference.
    """
    global _model, _model_version

    if _model is not None and not force_reload:
        return True

    model_path = _find_model_path()
    if model_path is None:
        log.warning("No model checkpoint found at any search path")
        return False

    try:
        _model = CNN_LSTM_IDS()
        state_dict = torch.load(model_path, map_location=_device, weights_only=True)
        _model.load_state_dict(state_dict)
        _model.eval()
        _model_version = Path(model_path).stem
        log.info(f"✅ Loaded model from {model_path} (version: {_model_version})")
        return True
    except Exception as e:
        log.error(f"❌ Failed to load model: {e}")
        _model = None
        return False


def get_model_info() -> dict:
    """Return info about the loaded model."""
    model_path = _find_model_path()
    return {
        "loaded": _model is not None,
        "version": _model_version if _model else None,
        "path": model_path,
        "architecture": "CNN-LSTM (Conv1d→ReLU→LSTM→Linear)",
        "input_shape": f"(batch, {SEQ_LEN}, {NUM_FEATURES})",
        "threshold": THRESHOLD,
    }


# ── Inference ────────────────────────────────────────────
def run_inference(features: list[list[float]]) -> dict:
    """
    Run inference on a sequence of feature vectors with explainability.

    Args:
        features: List of 10 feature vectors, each with 78 floats.
                  Shape: (seq_len=10, num_features=78)

    Returns:
        dict with score, label, confidence, AND explanation
    """
    if _model is None:
        if not load_model():
            raise RuntimeError("Model not loaded — no checkpoint available")

    t0 = time.perf_counter()

    # Convert to tensor: (1, 10, 78)
    arr = np.array(features, dtype=np.float32)
    if arr.shape != (SEQ_LEN, NUM_FEATURES):
        raise ValueError(
            f"Expected shape ({SEQ_LEN}, {NUM_FEATURES}), got {arr.shape}"
        )

    tensor = torch.from_numpy(arr).unsqueeze(0).to(_device)

    with torch.no_grad():
        logit = _model(tensor).squeeze()
        prob = torch.sigmoid(logit).item()

    latency_ms = (time.perf_counter() - t0) * 1000

    label = "attack" if prob >= THRESHOLD else "benign"
    confidence = prob if label == "attack" else 1.0 - prob

    # ADD EXPLAINABILITY
    explanation_data = explain_prediction(
        window=features,
        score=prob,
        label=label
    )

    return {
        "score": round(prob, 6),
        "label": label,
        "confidence": round(confidence, 6),
        "inference_latency_ms": round(latency_ms, 2),
        "model_version": _model_version,
        "explanation": explanation_data["explanation"],
        "top_anomalies": explanation_data["top_anomalies"],
        "temporal_pattern": explanation_data["temporal_pattern"],
        "anomaly_count": explanation_data["anomaly_count"],
    }

def run_batch_inference(batch: list[list[list[float]]]) -> list[dict]:
    """
    Run inference on a batch of sequences.

    Args:
        batch: List of N sequences, each (10, 78).

    Returns:
        List of N result dicts.
    """
    if _model is None:
        if not load_model():
            raise RuntimeError("Model not loaded — no checkpoint available")

    t0 = time.perf_counter()

    arr = np.array(batch, dtype=np.float32)
    if len(arr.shape) != 3 or arr.shape[1] != SEQ_LEN or arr.shape[2] != NUM_FEATURES:
        raise ValueError(
            f"Expected shape (N, {SEQ_LEN}, {NUM_FEATURES}), got {arr.shape}"
        )

    tensor = torch.from_numpy(arr).to(_device)

    with torch.no_grad():
        logits = _model(tensor).squeeze(-1)
        probs = torch.sigmoid(logits)

    total_ms = (time.perf_counter() - t0) * 1000
    per_sample_ms = total_ms / len(batch)

    results = []
    for idx, prob_val in enumerate(probs.tolist()):
        if not isinstance(prob_val, float):
            prob_val = float(prob_val)
        label = "attack" if prob_val >= THRESHOLD else "benign"
        confidence = prob_val if label == "attack" else 1.0 - prob_val
        
        # Generate explanations for each sequence
        explanation_data = explain_prediction(
            window=batch[idx],
            score=prob_val,
            label=label
        )
        
        results.append({
            "score": round(prob_val, 6),
            "label": label,
            "confidence": round(confidence, 6),
            "inference_latency_ms": round(per_sample_ms, 2),
            "model_version": _model_version,
            "explanation": explanation_data["explanation"],
            "top_anomalies": explanation_data["top_anomalies"],
            "temporal_pattern": explanation_data["temporal_pattern"],
            "anomaly_count": explanation_data["anomaly_count"],
        })

    return results


# ── Database operations ──────────────────────────────────

async def save_prediction(
    db: AsyncSession,
    device_id: UUID,
    result: dict,
    window_start_idx: Optional[int] = None,
    window_end_idx: Optional[int] = None,
) -> Prediction:
    """Save a prediction result to the database."""
    pred = Prediction(
        device_id=device_id,
        score=result["score"],
        label=result["label"],
        confidence=result["confidence"],
        model_version=result["model_version"],
        inference_latency_ms=result["inference_latency_ms"],
        window_start_idx=window_start_idx,
        window_end_idx=window_end_idx,
        top_anomalies=result.get("top_anomalies"),
        temporal_pattern=result.get("temporal_pattern"),
    )
    db.add(pred)
    await db.commit()
    await db.refresh(pred)
    return pred


async def get_predictions_for_device(
    db: AsyncSession,
    device_id: UUID,
    limit: int = 100,
) -> list[Prediction]:
    """Get recent predictions for a specific device."""
    result = await db.execute(
        select(Prediction)
        .where(Prediction.device_id == device_id)
        .order_by(Prediction.timestamp.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


async def get_prediction_summary(db: AsyncSession) -> dict:
    """Get aggregate prediction statistics for the dashboard."""
    total = await db.execute(select(func.count(Prediction.id)))
    total_count = total.scalar() or 0

    attack = await db.execute(
        select(func.count(Prediction.id)).where(Prediction.label == "attack")
    )
    attack_count = attack.scalar() or 0

    benign_count = total_count - attack_count

    avg_conf = await db.execute(select(func.avg(Prediction.confidence)))
    avg_confidence = avg_conf.scalar() or 0.0

    avg_lat = await db.execute(select(func.avg(Prediction.inference_latency_ms)))
    avg_latency = avg_lat.scalar() or 0.0

    return {
        "total_predictions": total_count,
        "attack_count": attack_count,
        "benign_count": benign_count,
        "attack_rate": round(attack_count / total_count, 4) if total_count > 0 else 0.0,
        "avg_confidence": round(float(avg_confidence), 4),
        "avg_latency_ms": round(float(avg_latency), 2),
    }
