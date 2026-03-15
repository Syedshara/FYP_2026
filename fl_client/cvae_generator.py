"""
CVAE-based Traffic Generator — generates synthetic attack/benign traffic
windows using the trained Conditional VAE decoder.

Loads the CVAE decoder, scaler, and (optionally) class centroids from
``/app/models/`` and generates (10, 78) windows conditioned on a specific
attack class.  Matches the SyntheticGenerator public API exactly so it
can be a drop-in replacement inside the monitor loop.

Parameters
----------
class_id     : int   — CVAE class index (0-14, see CLASS_NAMES)
attack_ratio : float — fraction of windows that are attack (rest are benign)
seed         : int   — optional random seed for reproducibility

Usage
-----
    gen = CVAEGenerator(class_id=6, attack_ratio=0.7)
    window, label, attack_frac = gen.get_next_window()
    # window: np.ndarray (10, 78)
    # label: int (0=benign, 1=attack)
    # attack_frac: float
"""

from __future__ import annotations

import logging
import os
import sys
import warnings
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn.functional as F

# Suppress sklearn version mismatch warnings from pickled scalers
warnings.filterwarnings("ignore", category=UserWarning, module="sklearn")

# Shared CVAE module
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from fl_common.cvae import CVAEDecoder, NUM_CLASSES, LATENT_DIM, SEQ_LEN, NUM_FEATURES

log = logging.getLogger("cvae_generator")

# Default model directory (inside Docker containers)
_DEFAULT_MODEL_DIR = "/app/models"

# Generation parameters
_BATCH_SIZE = 16       # decode this many windows at once, yield one-by-one
_SIGMA = 0.3           # std of latent noise around zero (no centroid needed)


class CVAEGenerator:
    """
    Generates synthetic traffic windows using the CVAE decoder.

    Matches the SyntheticGenerator / ReplaySimulator public API:
        get_next_window() → (window, label, attack_frac)
        total_windows, current_index, progress, exhausted  (properties)
        get_stats() → dict

    The generator never exhausts (infinite supply).
    """

    def __init__(
        self,
        class_id: int = 0,
        attack_ratio: float = 0.7,
        model_dir: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> None:
        self._class_id = class_id
        self._attack_ratio = max(0.0, min(1.0, attack_ratio))
        self._model_dir = Path(model_dir or os.environ.get("MODEL_DIR", _DEFAULT_MODEL_DIR))
        self._device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self._rng = np.random.default_rng(seed)
        self._total_generated = 0

        # Pre-generated buffer (decode in batches for efficiency)
        self._attack_buffer: list[np.ndarray] = []
        self._benign_buffer: list[np.ndarray] = []

        # Load model artifacts
        self._decoder = self._load_decoder()
        self._scaler = self._load_scaler()

        log.info(
            "CVAEGenerator ready: class_id=%d  attack_ratio=%.0f%%  "
            "device=%s  model_dir=%s  infinite=True",
            self._class_id,
            self._attack_ratio * 100,
            self._device,
            self._model_dir,
        )

    # ── Model loading ────────────────────────────────────

    def _load_decoder(self) -> CVAEDecoder:
        """Load the CVAE decoder weights."""
        decoder_path = self._model_dir / "cvae_decoder.pt"
        if not decoder_path.exists():
            raise FileNotFoundError(
                f"CVAE decoder not found at {decoder_path}. "
                "Ensure model artifacts are mounted at /app/models/"
            )
        decoder = CVAEDecoder()
        decoder.load_state_dict(
            torch.load(str(decoder_path), map_location=self._device, weights_only=True)
        )
        decoder.to(self._device).eval()
        log.info("Loaded CVAE decoder from %s", decoder_path)
        return decoder

    def _load_scaler(self):
        """Load the sklearn StandardScaler for inverse-transforming outputs."""
        scaler_path = self._model_dir / "cvae_scaler.pkl"
        if not scaler_path.exists():
            log.warning("CVAE scaler not found at %s — outputs will be in scaled space", scaler_path)
            return None
        try:
            import joblib
            scaler = joblib.load(str(scaler_path))
            log.info("Loaded CVAE scaler from %s", scaler_path)
            return scaler
        except Exception as exc:
            log.warning("Failed to load scaler: %s — outputs will be in scaled space", exc)
            return None

    # ── Batch generation ─────────────────────────────────

    @torch.no_grad()
    def _generate_batch(self, class_id: int, n: int = _BATCH_SIZE) -> list[np.ndarray]:
        """
        Generate a batch of (SEQ_LEN, NUM_FEATURES) windows for the given class.

        Returns a list of numpy arrays, each shape (10, 78).
        """
        z = torch.randn(n, LATENT_DIM, device=self._device) * _SIGMA
        cond = F.one_hot(
            torch.full((n,), class_id, dtype=torch.long, device=self._device),
            num_classes=NUM_CLASSES,
        ).float()
        raw = self._decoder(z, cond)  # (n, 10, 78)

        # Inverse-scale if scaler is available
        arr = raw.cpu().numpy()  # (n, 10, 78)
        if self._scaler is not None:
            flat = arr.reshape(-1, NUM_FEATURES)  # (n*10, 78)
            try:
                flat = self._scaler.inverse_transform(flat)
            except Exception:
                pass  # keep scaled values if transform fails
            arr = flat.reshape(n, SEQ_LEN, NUM_FEATURES)

        return [arr[i].astype(np.float32) for i in range(n)]

    def _refill_attack_buffer(self) -> None:
        """Refill the attack window buffer."""
        self._attack_buffer = self._generate_batch(self._class_id)

    def _refill_benign_buffer(self) -> None:
        """Refill the benign window buffer (class 0 = benign)."""
        self._benign_buffer = self._generate_batch(0)

    # ── Public Interface (matches SyntheticGenerator API) ──

    @property
    def total_windows(self) -> int:
        """CVAE generator has unlimited windows."""
        return 999_999

    @property
    def current_index(self) -> int:
        return self._total_generated

    @property
    def total_replayed(self) -> int:
        return self._total_generated

    @property
    def progress(self) -> float:
        """Progress is always 0 for infinite generator."""
        return 0.0

    @property
    def exhausted(self) -> bool:
        """CVAE generator never exhausts."""
        return False

    def get_next_window(self) -> tuple[np.ndarray, int, float]:
        """
        Generate the next synthetic window.

        Returns
        -------
        (window, true_label, attack_fraction)
            window          : np.ndarray (10, 78)
            true_label      : int (0=benign, 1=attack)
            attack_fraction : float (configured attack ratio)
        """
        is_attack = self._rng.random() < self._attack_ratio

        if is_attack:
            if not self._attack_buffer:
                self._refill_attack_buffer()
            window = self._attack_buffer.pop()
            label = 1
        else:
            if not self._benign_buffer:
                self._refill_benign_buffer()
            window = self._benign_buffer.pop()
            label = 0

        self._total_generated += 1
        return window, label, self._attack_ratio

    def generate_window(self) -> tuple[np.ndarray, float]:
        """Compatibility wrapper matching TrafficSimulator API."""
        window, _, attack_fraction = self.get_next_window()
        return window, attack_fraction

    def get_stats(self) -> dict:
        """Return generator statistics."""
        return {
            "total_windows": "infinite",
            "current_index": self._total_generated,
            "total_replayed": self._total_generated,
            "progress": 0.0,
            "exhausted": False,
            "attack_ratio": round(self._attack_ratio, 4),
            "class_id": self._class_id,
            "type": "cvae",
        }

    def reset(self) -> None:
        """Reset counter and buffers."""
        self._total_generated = 0
        self._attack_buffer.clear()
        self._benign_buffer.clear()
        log.info("CVAEGenerator reset")
