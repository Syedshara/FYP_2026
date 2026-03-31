"""
Gradient poisoning strategies for FL adversarial simulation.

This module provides realistic gradient manipulation attacks that can be
activated on a per-client basis via a file-based signal.  The signal file
is checked at the START of every training round, allowing mid-training
toggling without container restart.

Signal file
-----------
``/app/.poison_mode``  (or ``<fl_client_dir>/.poison_mode``)

Format (single line):
    <strategy>            e.g.  "direction_flip"

Strategies
----------
direction_flip  — Reverses gradient direction + amplifies by 1.5-3x.
                  This is the classic model-poisoning attack from
                  Fang et al. (2020).  Highly detectable by RECESS due
                  to cosine similarity collapse.

scale_attack    — Amplifies honest gradients by 5-10x.  Subtler than
                  direction_flip because the direction is preserved;
                  RECESS catches it via magnitude divergence.

noise_inject    — Replaces honest gradients with random Gaussian noise
                  of comparable magnitude.  Mimics a compromised node
                  with corrupted memory.

none            — Passthrough.  Equivalent to honest training.
"""

import logging
import os
import time
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

# Path inside the container (fl_client is bind-mounted at /app)
_SIGNAL_FILE = os.path.join(os.path.dirname(__file__), ".poison_mode")

# Cache to avoid log spam on every round
_last_logged_strategy: Optional[str] = None
_last_log_time: float = 0.0


def read_poison_strategy() -> Optional[str]:
    """
    Read the current poison strategy from the signal file.

    Returns None if the file is absent or contains 'none'.
    Caches the log message to avoid flooding every round.
    """
    global _last_logged_strategy, _last_log_time

    if not os.path.exists(_SIGNAL_FILE):
        if _last_logged_strategy is not None:
            log.info("Poison signal file removed — reverting to honest mode")
            _last_logged_strategy = None
        return None

    try:
        with open(_SIGNAL_FILE, "r") as f:
            strategy = f.read().strip().lower()
    except OSError:
        return None

    if strategy in ("", "none"):
        if _last_logged_strategy is not None:
            log.info("Poison mode disabled (strategy=none)")
            _last_logged_strategy = None
        return None

    # Rate-limit log to once per 30s per strategy change
    now = time.time()
    if strategy != _last_logged_strategy or (now - _last_log_time) > 30:
        log.warning(
            "⚠ POISON MODE ACTIVE: strategy=%s (signal file: %s)",
            strategy,
            _SIGNAL_FILE,
        )
        _last_logged_strategy = strategy
        _last_log_time = now

    return strategy


def poison_gradient(
    gradient_dict: dict, strategy: str, rng: np.random.Generator | None = None
) -> dict:
    """
    Apply a poisoning strategy to a gradient dictionary.

    Parameters
    ----------
    gradient_dict : dict[str, Tensor]
        Layer name → gradient tensor (torch or numpy).
    strategy : str
        One of 'direction_flip', 'scale_attack', 'noise_inject'.
    rng : numpy Generator, optional
        For reproducibility in tests.

    Returns
    -------
    dict[str, Tensor]
        Poisoned gradient dictionary (same shape, same device).
    """
    import torch

    if rng is None:
        rng = np.random.default_rng()

    if strategy == "direction_flip":
        return _direction_flip(gradient_dict, rng)
    elif strategy == "scale_attack":
        return _scale_attack(gradient_dict, rng)
    elif strategy == "noise_inject":
        return _noise_inject(gradient_dict, rng)
    else:
        log.warning("Unknown poison strategy '%s' — passing through", strategy)
        return gradient_dict


def _direction_flip(gradient_dict: dict, rng: np.random.Generator) -> dict:
    """
    Reverse gradient direction + amplify by random factor in [1.5, 3.0].

    This is the strongest attack: cosine similarity between honest and
    poisoned gradients will be ≈ -1.0, making RECESS direction_score ≈ 1.0.
    """
    import torch

    factor = rng.uniform(1.5, 3.0)
    poisoned = {}
    for key, tensor in gradient_dict.items():
        if isinstance(tensor, torch.Tensor):
            poisoned[key] = -tensor * factor
        else:
            poisoned[key] = torch.tensor(-np.array(tensor) * factor)
    log.debug("direction_flip: factor=%.2f", factor)
    return poisoned


def _scale_attack(gradient_dict: dict, rng: np.random.Generator) -> dict:
    """
    Amplify gradients by random factor in [5.0, 10.0].

    Direction is preserved (cosine ≈ 1.0) but magnitude ratio will be
    5-10x, triggering RECESS magnitude_score.
    """
    import torch

    factor = rng.uniform(5.0, 10.0)
    poisoned = {}
    for key, tensor in gradient_dict.items():
        if isinstance(tensor, torch.Tensor):
            poisoned[key] = tensor * factor
        else:
            poisoned[key] = torch.tensor(np.array(tensor) * factor)
    log.debug("scale_attack: factor=%.2f", factor)
    return poisoned


def _noise_inject(gradient_dict: dict, rng: np.random.Generator) -> dict:
    """
    Replace gradient with Gaussian noise of comparable magnitude.

    This simulates a compromised node with corrupted memory.  Both
    direction and magnitude will diverge from honest updates.
    """
    import torch

    poisoned = {}
    for key, tensor in gradient_dict.items():
        if isinstance(tensor, torch.Tensor):
            magnitude = tensor.norm().item()
            noise = torch.randn_like(tensor) * max(magnitude, 1e-6)
            poisoned[key] = noise
        else:
            arr = np.array(tensor)
            magnitude = np.linalg.norm(arr)
            noise = rng.standard_normal(arr.shape).astype(arr.dtype) * max(
                magnitude, 1e-6
            )
            poisoned[key] = torch.tensor(noise)
    log.debug("noise_inject: replaced with random noise")
    return poisoned


def write_poison_signal(strategy: str) -> None:
    """
    Write or clear the poison signal file.  Used by the backend API
    to toggle poison mode on a running client.

    Parameters
    ----------
    strategy : str
        'direction_flip', 'scale_attack', 'noise_inject', or 'none'.
        'none' or empty string removes the signal file.
    """
    if strategy in ("", "none"):
        if os.path.exists(_SIGNAL_FILE):
            os.remove(_SIGNAL_FILE)
            log.info("Poison signal file removed")
        return

    with open(_SIGNAL_FILE, "w") as f:
        f.write(strategy)
    log.info("Poison signal file written: strategy=%s", strategy)


def clear_all_poison_signals(base_dir: str | None = None) -> int:
    """
    Remove all .poison_mode files under the given base directory.
    Used on training start/stop to ensure clean state.

    Returns the number of files removed.
    """
    if base_dir is None:
        base_dir = os.path.dirname(__file__)

    count = 0
    signal_path = os.path.join(base_dir, ".poison_mode")
    if os.path.exists(signal_path):
        os.remove(signal_path)
        count += 1
    return count
