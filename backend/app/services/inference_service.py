"""
IDS Inference Service — loads the CNN-LSTM model and runs real-time predictions.

Pipeline:
    78-feature vectors (from capture_service) → StandardScaler normalization
    → sliding window (10 timesteps) → CNN-LSTM model → binary prediction
    → WebSocket broadcast

The model is loaded once at startup and kept in memory.
"""

from __future__ import annotations

import asyncio
import logging
import os
import pickle
import time
from collections import deque
from typing import Any

import numpy as np

from app.config import settings

log = logging.getLogger(__name__)

# ── Globals (loaded once) ────────────────────────────────

_model = None          # CNN_LSTM_IDS instance (torch)
_scaler = None         # sklearn StandardScaler
_torch = None          # torch module (lazy import)
_model_lock = asyncio.Lock()
_is_loaded = False


# ── Model loading ────────────────────────────────────────

async def ensure_model_loaded() -> bool:
    """
    Load the CNN-LSTM model and scaler if not already loaded.
    Returns True if model is ready for inference.

    Lazy-imports torch to avoid import errors when torch is not installed
    (e.g., in development/test environments).
    """
    global _model, _scaler, _torch, _is_loaded

    if _is_loaded:
        return True

    async with _model_lock:
        if _is_loaded:
            return True

        try:
            import torch
            _torch = torch
        except ImportError:
            log.error("PyTorch not installed — inference unavailable")
            return False

        # ── Load model ──
        model_path = settings.MODEL_PATH
        if not os.path.exists(model_path):
            log.warning("Model file not found at %s — inference unavailable", model_path)
            return False

        try:
            # Import model class — it's in fl_common which is mounted at /fl_common
            # in the Docker container. We add it to sys.path if needed.
            import sys
            fl_common_paths = ["/fl_common", os.path.join(os.path.dirname(__file__), "../../../fl_common")]
            for p in fl_common_paths:
                abs_p = os.path.abspath(p)
                if os.path.isdir(abs_p) and abs_p not in sys.path:
                    sys.path.insert(0, os.path.dirname(abs_p))

            from fl_common.model import CNN_LSTM_IDS

            device = torch.device("cpu")  # Inference on CPU in the backend
            model = CNN_LSTM_IDS(
                seq_len=settings.SEQUENCE_LENGTH,
                num_features=settings.NUM_FEATURES,
            ).to(device)

            state_dict = torch.load(model_path, map_location=device, weights_only=True)
            model.load_state_dict(state_dict)
            model.eval()
            _model = model

            log.info("CNN-LSTM model loaded from %s", model_path)

        except Exception as exc:
            log.error("Failed to load CNN-LSTM model: %s", exc, exc_info=True)
            return False

        # ── Load scaler ──
        scaler_path = settings.SCALER_PATH
        if os.path.exists(scaler_path):
            try:
                with open(scaler_path, "rb") as f:
                    _scaler = pickle.load(f)
                log.info("StandardScaler loaded from %s", scaler_path)
            except Exception as exc:
                log.warning("Failed to load scaler: %s — using raw features", exc)
                _scaler = None
        else:
            log.warning("Scaler file not found at %s — using raw features", scaler_path)
            _scaler = None

        _is_loaded = True
        return True


def is_model_loaded() -> bool:
    """Check if the model is ready."""
    return _is_loaded


# ── Inference ────────────────────────────────────────────

class InferenceWindow:
    """
    Maintains a sliding window of feature vectors for sequence-based inference.

    The CNN-LSTM model expects input shape (batch, seq_len=10, num_features=78).
    We accumulate feature vectors and run inference once we have a full window.
    After each prediction, the window slides forward.
    """

    def __init__(
        self,
        seq_len: int = settings.SEQUENCE_LENGTH,
        num_features: int = settings.NUM_FEATURES,
    ):
        self.seq_len = seq_len
        self.num_features = num_features
        self._buffer: deque[np.ndarray] = deque(maxlen=seq_len)

    def add_features(self, features: np.ndarray) -> np.ndarray | None:
        """
        Add a feature vector (78,) and return a full window (10, 78) if available.
        Returns None if the buffer is not yet full.
        """
        # Strip the label column (index 77) — model doesn't use it
        if features.shape[0] == self.num_features:
            # The 78th feature is the label placeholder — keep only first 77
            # Actually, the model uses 78 features (num_features=78 in config)
            # The label at index 77 should be 0 (set by capture_service)
            pass

        self._buffer.append(features.copy())

        if len(self._buffer) >= self.seq_len:
            window = np.array(list(self._buffer), dtype=np.float32)
            return window  # shape: (seq_len, num_features)

        return None

    @property
    def buffer_size(self) -> int:
        return len(self._buffer)

    def clear(self) -> None:
        self._buffer.clear()


def run_inference(window: np.ndarray, threshold: float = settings.DEFAULT_THRESHOLD) -> dict[str, Any]:
    """
    Run inference on a single window (seq_len, num_features).

    Returns:
        {
            "score": float,         # raw sigmoid probability
            "label": "attack" | "benign",
            "confidence": float,    # confidence in the predicted label
            "inference_latency_ms": float,
        }
    """
    if _model is None or _torch is None:
        return {
            "score": 0.0,
            "label": "unknown",
            "confidence": 0.0,
            "inference_latency_ms": 0.0,
            "error": "model_not_loaded",
        }

    t0 = time.perf_counter()

    # Apply scaler if available
    if _scaler is not None:
        try:
            # Scaler expects (n_samples, n_features) — reshape, transform, reshape back
            original_shape = window.shape
            flat = window.reshape(-1, original_shape[-1])
            flat = _scaler.transform(flat)
            window = flat.reshape(original_shape).astype(np.float32)
        except Exception as exc:
            log.warning("Scaler transform failed: %s — using raw features", exc)

    # Replace any remaining NaN/inf
    window = np.nan_to_num(window, nan=0.0, posinf=0.0, neginf=0.0)

    # Convert to tensor and run model
    tensor = _torch.from_numpy(window).unsqueeze(0)  # (1, seq_len, num_features)

    with _torch.no_grad():
        logit = _model(tensor).squeeze()
        prob = _torch.sigmoid(logit).item()

    latency = (time.perf_counter() - t0) * 1000
    label = "attack" if prob >= threshold else "benign"
    confidence = prob if label == "attack" else 1.0 - prob

    return {
        "score": round(prob, 6),
        "label": label,
        "confidence": round(confidence, 6),
        "inference_latency_ms": round(latency, 2),
    }


def run_batch_inference(
    windows: list[np.ndarray],
    threshold: float = settings.DEFAULT_THRESHOLD,
) -> list[dict[str, Any]]:
    """
    Run inference on multiple windows at once (batched for efficiency).

    Each window should be shape (seq_len, num_features).
    Returns a list of prediction dicts.
    """
    if not windows or _model is None or _torch is None:
        return []

    t0 = time.perf_counter()

    batch = np.stack(windows, axis=0).astype(np.float32)  # (B, T, F)

    # Apply scaler
    if _scaler is not None:
        try:
            B, T, F = batch.shape
            flat = batch.reshape(-1, F)
            flat = _scaler.transform(flat)
            batch = flat.reshape(B, T, F).astype(np.float32)
        except Exception as exc:
            log.warning("Batch scaler transform failed: %s", exc)

    batch = np.nan_to_num(batch, nan=0.0, posinf=0.0, neginf=0.0)
    tensor = _torch.from_numpy(batch)

    with _torch.no_grad():
        logits = _model(tensor).squeeze(-1)  # (B,)
        probs = _torch.sigmoid(logits)

    latency = (time.perf_counter() - t0) * 1000
    per_item_latency = latency / len(windows)

    results = []
    for prob_val in probs.cpu().numpy():
        prob = float(prob_val)
        label = "attack" if prob >= threshold else "benign"
        confidence = prob if label == "attack" else 1.0 - prob
        results.append({
            "score": round(prob, 6),
            "label": label,
            "confidence": round(confidence, 6),
            "inference_latency_ms": round(per_item_latency, 2),
        })

    return results


# ── Pipeline Integration ─────────────────────────────────

async def run_capture_inference_pipeline(
    stop_event: asyncio.Event,
    run_id: int,
    attack_id: int,
    broadcast_fn,
) -> dict[str, Any]:
    """
    Main pipeline: capture packets → extract features → run inference → broadcast.

    This is the top-level function called when an attack run starts.

    Args:
        stop_event: Set this to stop the pipeline.
        run_id: Attack run ID for tracking.
        attack_id: Attack template ID.
        broadcast_fn: async callable(message_dict) to broadcast via WebSocket.

    Returns:
        Summary dict with counts and timing.
    """
    from app.services.capture_service import capture_packets

    # Ensure model is loaded
    model_ready = await ensure_model_loaded()
    if not model_ready:
        log.warning("Model not ready — capture pipeline will run without inference")

    inference_window = InferenceWindow()
    stats = {
        "total_flows": 0,
        "total_predictions": 0,
        "attack_predictions": 0,
        "benign_predictions": 0,
        "avg_latency_ms": 0.0,
        "avg_confidence": 0.0,
    }
    latencies: list[float] = []
    confidences: list[float] = []

    try:
        async for feature_batch in capture_packets(stop_event):
            for features in feature_batch:
                stats["total_flows"] += 1

                if not model_ready:
                    continue

                window = inference_window.add_features(features)
                if window is None:
                    continue  # Buffer not full yet

                # Run inference
                result = run_inference(window)
                stats["total_predictions"] += 1

                if result["label"] == "attack":
                    stats["attack_predictions"] += 1
                else:
                    stats["benign_predictions"] += 1

                latencies.append(result["inference_latency_ms"])
                confidences.append(result["confidence"])

                # Broadcast prediction
                await broadcast_fn({
                    "type": "prediction",
                    "data": {
                        "run_id": run_id,
                        "attack_id": attack_id,
                        "source": "capture_pipeline",
                        **result,
                    },
                    "timestamp": time.time(),
                })

    except Exception as exc:
        log.error("Capture-inference pipeline error: %s", exc, exc_info=True)

    # Compute averages
    if latencies:
        stats["avg_latency_ms"] = round(sum(latencies) / len(latencies), 2)
    if confidences:
        stats["avg_confidence"] = round(sum(confidences) / len(confidences), 4)

    log.info(
        "Pipeline complete for run %d: %d flows, %d predictions (%d attack, %d benign)",
        run_id, stats["total_flows"], stats["total_predictions"],
        stats["attack_predictions"], stats["benign_predictions"],
    )

    return stats
