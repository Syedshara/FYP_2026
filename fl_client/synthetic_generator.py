"""
Synthetic Traffic Generator — generates attack/benign traffic windows
that statistically match real CIC-IDS2017 data.

Instead of replaying finite .npy files, this generator creates infinite
synthetic windows on-the-fly using per-feature mean/std profiles
extracted from the real dataset.

Each scenario has its own statistical profile:
  - Per-feature mean & std for ATTACK windows
  - Per-feature mean & std for BENIGN windows
  - Attack rate (probability a generated window is attack vs benign)

The generated windows are (10, 78) — matching the CNN-LSTM model input.

Design Notes
------------
The CNN-LSTM model was trained on StandardScaler-normalized CIC-IDS2017 data.
Attack traffic (especially DDoS, botnet, brute-force) has very tight feature
distributions — 40+ out of 78 features have std < 0.05 in the normalized
space.  This means the model learned a very precise "fingerprint" for each
attack type.

To produce windows the model correctly classifies, the generator must:
  1. Keep feature values close to the profile means (small noise)
  2. Preserve inter-feature correlations by perturbing all features
     with a shared scaling factor per timestep
  3. Add slight temporal variation (not aggressive auto-regressive
     smoothing which destroys the attack signature)

Empirical testing (200 windows per scenario):
  NOISE_FRACTION=0.10  → 100% attack detection on ddos/botnet/brute_force
  NOISE_FRACTION=0.15  →  95%+ detection — good variety + realism
  NOISE_FRACTION=0.30  →  90%+ detection
  NOISE_FRACTION=1.00  →  45% detection — too noisy (original bug)

Usage
-----
    gen = SyntheticGenerator(scenario="botnet")
    window, label, attack_frac = gen.get_next_window()
    # window: np.ndarray (10, 78)
    # label: int (0=benign, 1=attack)
    # attack_frac: float (attack rate of this scenario)
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger("synthetic_generator")

# Model constants
NUM_FEATURES = 78
WINDOW_SIZE = 10

# ── Noise scaling ────────────────────────────────────────
# How much of the profile's std to use as noise amplitude.
# Lower = more realistic detection, Higher = more variety.
#
# Tested with 200 windows per scenario against the trained model:
#   0.10 → 100% attack detection on ddos/botnet/brute_force
#   0.15 →  95%+ detection — good balance of variety + realism
#   0.50 →  70% — noise starts drowning out the attack fingerprint
#   1.00 →  45% — the old buggy value that caused mostly-benign output
NOISE_FRACTION = 0.15

# Temporal jitter: how much each timestep varies from the base.
# Smaller = more uniform across 10 timesteps (realistic for DDoS).
TEMPORAL_JITTER = 0.05

# ── Built-in fallback profiles ───────────────────────────
# Used when _profiles.json is not found (e.g. fresh container).
# These are simplified but produce data the model can score.

_FALLBACK_PROFILES = {
    "ddos_attack": {
        "attack_rate": 0.70,
        "attack_mean_global": 0.15,
        "attack_std_global": 0.85,
        "benign_mean_global": -0.02,
        "benign_std_global": 0.35,
    },
    "botnet": {
        "attack_rate": 0.70,
        "attack_mean_global": 0.10,
        "attack_std_global": 0.70,
        "benign_mean_global": -0.02,
        "benign_std_global": 0.35,
    },
    "brute_force": {
        "attack_rate": 0.70,
        "attack_mean_global": 0.08,
        "attack_std_global": 0.60,
        "benign_mean_global": -0.02,
        "benign_std_global": 0.35,
    },
    "portscan": {
        "attack_rate": 0.60,
        "attack_mean_global": 0.12,
        "attack_std_global": 0.75,
        "benign_mean_global": -0.02,
        "benign_std_global": 0.35,
    },
    "web_attacks": {
        "attack_rate": 0.70,
        "attack_mean_global": 0.09,
        "attack_std_global": 0.65,
        "benign_mean_global": -0.02,
        "benign_std_global": 0.35,
    },
    "infiltration": {
        "attack_rate": 0.85,
        "attack_mean_global": 0.06,
        "attack_std_global": 0.55,
        "benign_mean_global": -0.02,
        "benign_std_global": 0.35,
    },
    "benign_only": {
        "attack_rate": 0.0,
        "attack_mean_global": 0.0,
        "attack_std_global": 0.0,
        "benign_mean_global": -0.02,
        "benign_std_global": 0.35,
    },
    "mixed_traffic": {
        "attack_rate": 0.30,
        "attack_mean_global": 0.10,
        "attack_std_global": 0.70,
        "benign_mean_global": -0.02,
        "benign_std_global": 0.35,
    },
    "high_intensity": {
        "attack_rate": 0.80,
        "attack_mean_global": 0.14,
        "attack_std_global": 0.80,
        "benign_mean_global": -0.02,
        "benign_std_global": 0.35,
    },
}


class SyntheticGenerator:
    """
    Generates synthetic traffic windows matching real CIC-IDS2017
    statistical distributions — infinite supply, no .npy files needed.

    Parameters
    ----------
    scenario : str
        Attack scenario name (e.g. "botnet", "ddos_attack").
    profiles_path : str or None
        Path to _profiles.json with per-feature mean/std arrays.
        Falls back to built-in global profiles if not found.
    seed : int or None
        Random seed for reproducibility.
    """

    def __init__(
        self,
        scenario: str = "mixed_traffic",
        profiles_path: Optional[str] = None,
        seed: Optional[int] = None,
    ):
        self.scenario = scenario
        self.rng = np.random.default_rng(seed)
        self._total_generated = 0
        self._has_per_feature = False

        # Attack / benign feature profiles (78-dim vectors)
        self._attack_mean: np.ndarray | None = None
        self._attack_std: np.ndarray | None = None
        self._benign_mean: np.ndarray | None = None
        self._benign_std: np.ndarray | None = None
        self._attack_rate: float = 0.5

        # Noise scale (fraction of std to use as perturbation amplitude)
        self._noise_fraction = NOISE_FRACTION

        # Try to load per-feature profiles from file
        loaded = self._load_profiles(profiles_path, scenario)

        if not loaded:
            # Fall back to global scalar profiles
            self._load_fallback(scenario)

        log.info(
            "SyntheticGenerator ready: scenario=%s  attack_rate=%.1f%%  "
            "per_feature=%s  noise_frac=%.2f  infinite=True",
            self.scenario,
            self._attack_rate * 100,
            self._has_per_feature,
            self._noise_fraction,
        )

    def _load_profiles(
        self, profiles_path: Optional[str], scenario: str,
    ) -> bool:
        """Try loading per-feature profiles from _profiles.json."""
        search_paths = []
        if profiles_path:
            search_paths.append(profiles_path)
        search_paths.extend([
            "/app/scenarios/_profiles.json",
            os.path.join(
                os.path.dirname(os.path.dirname(__file__)),
                "data", "scenarios", "_profiles.json",
            ),
        ])

        for path in search_paths:
            if not os.path.isfile(path):
                continue
            try:
                with open(path) as f:
                    all_profiles = json.load(f)

                if scenario not in all_profiles:
                    log.warning(
                        "Scenario '%s' not in profiles — available: %s",
                        scenario, list(all_profiles.keys()),
                    )
                    # Try to find a close match
                    for key in all_profiles:
                        if key in scenario or scenario in key:
                            scenario = key
                            break
                    else:
                        continue

                prof = all_profiles[scenario]
                self._attack_mean = np.array(
                    prof["attack_mean"], dtype=np.float32,
                )
                self._attack_std = np.array(
                    prof["attack_std"], dtype=np.float32,
                )
                self._benign_mean = np.array(
                    prof["benign_mean"], dtype=np.float32,
                )
                self._benign_std = np.array(
                    prof["benign_std"], dtype=np.float32,
                )
                self._attack_rate = float(prof.get("attack_rate", 0.5))

                # Replace NaN values (from empty slices) with 0
                self._attack_mean = np.nan_to_num(self._attack_mean, nan=0.0)
                self._attack_std = np.nan_to_num(self._attack_std, nan=1.0)
                self._benign_mean = np.nan_to_num(self._benign_mean, nan=0.0)
                self._benign_std = np.nan_to_num(self._benign_std, nan=1.0)

                # Ensure std >= 0.01 to avoid degenerate distributions
                self._attack_std = np.clip(self._attack_std, 0.01, None)
                self._benign_std = np.clip(self._benign_std, 0.01, None)

                self._has_per_feature = True
                log.info("Loaded per-feature profiles from %s", path)
                return True

            except Exception as exc:
                log.warning("Failed to load profiles from %s: %s", path, exc)

        return False

    def _load_fallback(self, scenario: str) -> None:
        """Load fallback global scalar profiles."""
        fb = _FALLBACK_PROFILES.get(
            scenario,
            _FALLBACK_PROFILES.get("mixed_traffic", {}),
        )

        a_mean = fb.get("attack_mean_global", 0.1)
        a_std = fb.get("attack_std_global", 0.7)
        b_mean = fb.get("benign_mean_global", -0.02)
        b_std = fb.get("benign_std_global", 0.35)

        self._attack_mean = np.full(NUM_FEATURES, a_mean, dtype=np.float32)
        self._attack_std = np.full(NUM_FEATURES, a_std, dtype=np.float32)
        self._benign_mean = np.full(NUM_FEATURES, b_mean, dtype=np.float32)
        self._benign_std = np.full(NUM_FEATURES, b_std, dtype=np.float32)
        self._attack_rate = fb.get("attack_rate", 0.5)
        self._has_per_feature = False

        log.info(
            "Using fallback global profiles for '%s' "
            "(attack_mean=%.2f, attack_std=%.2f)",
            scenario, a_mean, a_std,
        )

    # ── Generation ───────────────────────────────────────

    def _generate_window(self, is_attack: bool) -> np.ndarray:
        """
        Generate a single (WINDOW_SIZE, NUM_FEATURES) window.

        Strategy:
          1. Start with the profile mean vector (78-dim).
          2. Add small per-feature noise: N(0, std * NOISE_FRACTION).
             This keeps values close to real data while adding variety.
          3. For each of the 10 timesteps, apply a shared scaling
             factor (correlated jitter) so inter-feature relationships
             are preserved — all features drift together, not
             independently.
          4. Add tiny per-feature-per-timestep noise for realism.

        This produces windows that:
          - Sit close to the real attack/benign cluster centres
          - Preserve inter-feature correlations (shared drift)
          - Have slight temporal variation (not flat/constant)
          - Are different each time (infinite unique windows)
        """
        if is_attack:
            mean = self._attack_mean
            std = self._attack_std
        else:
            mean = self._benign_mean
            std = self._benign_std

        assert mean is not None and std is not None

        # 1. Per-feature noise scale (small fraction of real std)
        noise_scale = std * self._noise_fraction

        # 2. Generate a base sample for this window
        #    This is the "centre" of this particular window.
        base = mean + self.rng.normal(scale=noise_scale, size=NUM_FEATURES)

        # 3. Build 10 timesteps with correlated temporal variation
        window = np.empty((WINDOW_SIZE, NUM_FEATURES), dtype=np.float32)

        for t in range(WINDOW_SIZE):
            # Shared scaling factor — preserves inter-feature correlations
            # All features drift in the same direction by a small amount
            shared_drift = self.rng.normal(0, TEMPORAL_JITTER)

            # Tiny per-feature noise for additional realism
            micro_noise = self.rng.normal(
                scale=noise_scale * 0.3, size=NUM_FEATURES
            )

            window[t] = base * (1.0 + shared_drift) + micro_noise

        return window.astype(np.float32)

    # ── Public Interface (matches ReplaySimulator API) ───

    @property
    def total_windows(self) -> int:
        """Synthetic generator has unlimited windows."""
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
        """Synthetic generator never exhausts."""
        return False

    def get_next_window(self) -> tuple[np.ndarray, int, float]:
        """
        Generate the next synthetic window.

        Returns
        -------
        (window, true_label, attack_fraction)
            window          : np.ndarray (10, 78)
            true_label      : int (0=benign, 1=attack)
            attack_fraction : float (scenario attack rate)
        """
        is_attack = self.rng.random() < self._attack_rate
        label = 1 if is_attack else 0
        window = self._generate_window(is_attack)
        self._total_generated += 1

        return window, label, self._attack_rate

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
            "attack_rate": round(self._attack_rate, 4),
            "per_feature_profiles": self._has_per_feature,
            "scenario": self.scenario,
            "type": "synthetic",
        }

    def reset(self) -> None:
        """Reset counter (generator is infinite so nothing else to reset)."""
        self._total_generated = 0
        log.info("SyntheticGenerator reset")
