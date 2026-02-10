"""
Synthetic traffic simulator — generates network flows matching the
CIC-IDS2017 78-feature format for the CNN-LSTM IDS model.

Each "flow" is a 78-dimensional vector. A "window" is a sequence of
10 consecutive flows, which is the input shape the model expects:
(batch, seq_len=10, num_features=78).

Features are generated to roughly mimic the statistical distribution of
real CIC-IDS2017 data:
  - Benign flows: low duration, moderate byte counts, no suspicious flags
  - Attack flows: anomalous patterns (high packet rates, unusual flag combos,
    extreme byte counts)
"""

from __future__ import annotations

import numpy as np
from typing import Optional


# ── CIC-IDS2017 feature names (78 features) ────────────
# These match the order used in preprocessing and training.
FEATURE_NAMES = [
    "Destination Port", "Flow Duration", "Total Fwd Packets",
    "Total Backward Packets", "Total Length of Fwd Packets",
    "Total Length of Bwd Packets", "Fwd Packet Length Max",
    "Fwd Packet Length Min", "Fwd Packet Length Mean",
    "Fwd Packet Length Std", "Bwd Packet Length Max",
    "Bwd Packet Length Min", "Bwd Packet Length Mean",
    "Bwd Packet Length Std", "Flow Bytes/s", "Flow Packets/s",
    "Flow IAT Mean", "Flow IAT Std", "Flow IAT Max", "Flow IAT Min",
    "Fwd IAT Total", "Fwd IAT Mean", "Fwd IAT Std", "Fwd IAT Max",
    "Fwd IAT Min", "Bwd IAT Total", "Bwd IAT Mean", "Bwd IAT Std",
    "Bwd IAT Max", "Bwd IAT Min", "Fwd PSH Flags", "Bwd PSH Flags",
    "Fwd URG Flags", "Bwd URG Flags", "Fwd Header Length",
    "Bwd Header Length", "Fwd Packets/s", "Bwd Packets/s",
    "Min Packet Length", "Max Packet Length", "Packet Length Mean",
    "Packet Length Std", "Packet Length Variance", "FIN Flag Count",
    "SYN Flag Count", "RST Flag Count", "PSH Flag Count",
    "ACK Flag Count", "URG Flag Count", "CWE Flag Count",
    "ECE Flag Count", "Down/Up Ratio", "Average Packet Size",
    "Avg Fwd Segment Size", "Avg Bwd Segment Size",
    "Fwd Header Length.1", "Fwd Avg Bytes/Bulk",
    "Fwd Avg Packets/Bulk", "Fwd Avg Bulk Rate",
    "Bwd Avg Bytes/Bulk", "Bwd Avg Packets/Bulk",
    "Bwd Avg Bulk Rate", "Subflow Fwd Packets",
    "Subflow Fwd Bytes", "Subflow Bwd Packets",
    "Subflow Bwd Bytes", "Init_Win_bytes_forward",
    "Init_Win_bytes_backward", "act_data_pkt_fwd",
    "min_seg_size_forward", "Active Mean", "Active Std",
    "Active Max", "Active Min", "Idle Mean", "Idle Std",
    "Idle Max", "Idle Min",
]

NUM_FEATURES = len(FEATURE_NAMES)   # 78
WINDOW_SIZE = 10


class TrafficSimulator:
    """
    Generate synthetic network traffic flows for the IDS model.

    Parameters
    ----------
    attack_ratio : float
        Fraction of flows that are attacks (0.0–1.0). Default 0.2 (20%).
    seed : int or None
        Random seed for reproducibility.
    """

    def __init__(self, attack_ratio: float = 0.2, seed: Optional[int] = None):
        self.attack_ratio = max(0.0, min(1.0, attack_ratio))
        self.rng = np.random.default_rng(seed)

    # ── Single flow generators ──────────────────────────

    def _benign_flow(self) -> np.ndarray:
        """
        Generate a single benign flow vector (78 features).

        Benign flows have:
          - Common destination ports (80, 443, 53, 8080, …)
          - Moderate duration, moderate packet sizes
          - Low or zero suspicious flag counts
          - Normal IAT distribution
        """
        rng = self.rng
        f = np.zeros(NUM_FEATURES, dtype=np.float32)

        # Destination port — common services
        f[0] = rng.choice([80, 443, 53, 22, 8080, 3306, 5432, 25, 110, 993])
        # Flow Duration (µs) — 0.1s to 30s
        f[1] = rng.uniform(1e5, 3e7)
        # Total Fwd/Bwd Packets — moderate counts
        f[2] = rng.integers(1, 50)
        f[3] = rng.integers(1, 40)
        # Total Length of Fwd/Bwd Packets
        f[4] = rng.uniform(100, 15000)
        f[5] = rng.uniform(100, 12000)
        # Fwd Packet Length stats
        f[6] = rng.uniform(40, 1500)       # max
        f[7] = rng.uniform(20, 60)         # min
        f[8] = rng.uniform(60, 800)        # mean
        f[9] = rng.uniform(0, 400)         # std
        # Bwd Packet Length stats
        f[10] = rng.uniform(40, 1500)
        f[11] = rng.uniform(20, 60)
        f[12] = rng.uniform(60, 700)
        f[13] = rng.uniform(0, 350)
        # Flow Bytes/s, Packets/s
        f[14] = rng.uniform(500, 500000)
        f[15] = rng.uniform(1, 500)
        # Flow IAT Mean/Std/Max/Min (µs)
        f[16] = rng.uniform(1e3, 1e6)
        f[17] = rng.uniform(0, 5e5)
        f[18] = rng.uniform(1e4, 5e6)
        f[19] = rng.uniform(0, 1e4)
        # Fwd IAT
        f[20] = rng.uniform(1e3, 5e6)
        f[21] = rng.uniform(1e3, 1e6)
        f[22] = rng.uniform(0, 5e5)
        f[23] = rng.uniform(1e4, 5e6)
        f[24] = rng.uniform(0, 1e4)
        # Bwd IAT
        f[25] = rng.uniform(1e3, 5e6)
        f[26] = rng.uniform(1e3, 1e6)
        f[27] = rng.uniform(0, 5e5)
        f[28] = rng.uniform(1e4, 5e6)
        f[29] = rng.uniform(0, 1e4)
        # PSH/URG flags — benign: usually 0 or 1
        f[30] = rng.choice([0, 1], p=[0.6, 0.4])
        f[31] = 0
        f[32] = 0
        f[33] = 0
        # Header lengths
        f[34] = rng.uniform(20, 60)
        f[35] = rng.uniform(20, 60)
        # Packets/s
        f[36] = rng.uniform(1, 200)
        f[37] = rng.uniform(1, 150)
        # Packet Length stats
        f[38] = rng.uniform(20, 60)        # min
        f[39] = rng.uniform(60, 1500)      # max
        f[40] = rng.uniform(60, 800)       # mean
        f[41] = rng.uniform(0, 400)        # std
        f[42] = f[41] ** 2                 # variance
        # TCP Flags — benign: SYN+ACK typical, minimal RST/URG
        f[43] = rng.choice([0, 1])         # FIN
        f[44] = rng.choice([0, 1])         # SYN
        f[45] = 0                          # RST
        f[46] = rng.choice([0, 1])         # PSH
        f[47] = 1                          # ACK
        f[48] = 0                          # URG
        f[49] = 0                          # CWE
        f[50] = 0                          # ECE
        # Down/Up Ratio
        f[51] = rng.uniform(0.5, 2.0)
        # Average Packet Size
        f[52] = rng.uniform(60, 800)
        f[53] = f[8]                       # Avg Fwd Seg = Fwd Mean
        f[54] = f[12]                      # Avg Bwd Seg = Bwd Mean
        # Fwd Header Length.1
        f[55] = f[34]
        # Bulk stats — mostly 0 for normal traffic
        f[56:62] = 0
        # Subflow
        f[62] = f[2]
        f[63] = f[4]
        f[64] = f[3]
        f[65] = f[5]
        # Init Window bytes
        f[66] = rng.uniform(8000, 65535)
        f[67] = rng.uniform(8000, 65535)
        # act_data_pkt_fwd, min_seg_size_forward
        f[68] = rng.integers(1, 20)
        f[69] = rng.uniform(20, 40)
        # Active/Idle Mean/Std/Max/Min (µs)
        f[70] = rng.uniform(0, 5e5)
        f[71] = rng.uniform(0, 2e5)
        f[72] = rng.uniform(0, 1e6)
        f[73] = rng.uniform(0, 1e5)
        f[74] = rng.uniform(0, 1e7)
        f[75] = rng.uniform(0, 5e6)
        f[76] = rng.uniform(0, 2e7)
        f[77] = rng.uniform(0, 5e6)

        return f

    def _attack_flow(self) -> np.ndarray:
        """
        Generate a single attack flow vector (78 features).

        Attack flows exhibit anomalous patterns:
          - Unusual ports (e.g. high random ports)
          - Very short or very long durations
          - Very high packet counts or byte volumes
          - Suspicious flag combinations (RST floods, URG, etc.)
          - Extreme IAT patterns (rapid bursts or very slow probing)
        """
        rng = self.rng
        f = np.zeros(NUM_FEATURES, dtype=np.float32)

        attack_style = rng.choice(["ddos", "portscan", "bruteforce", "infiltration"])

        if attack_style == "ddos":
            f[0] = rng.choice([80, 443, 53])
            f[1] = rng.uniform(1e2, 5e4)        # very short duration
            f[2] = rng.integers(500, 50000)      # massive fwd packets
            f[3] = rng.integers(0, 10)           # almost no bwd
            f[4] = rng.uniform(50000, 5e6)
            f[5] = rng.uniform(0, 500)
            f[14] = rng.uniform(1e6, 1e9)        # extreme bytes/s
            f[15] = rng.uniform(5000, 500000)    # extreme packets/s
            f[36] = rng.uniform(5000, 100000)
            f[37] = rng.uniform(0, 10)
        elif attack_style == "portscan":
            f[0] = rng.integers(1024, 65535)     # random high port
            f[1] = rng.uniform(0, 1e4)           # very short
            f[2] = rng.integers(1, 5)
            f[3] = rng.integers(0, 3)
            f[4] = rng.uniform(40, 200)
            f[5] = rng.uniform(0, 100)
            f[44] = 1                            # SYN flag
            f[45] = rng.choice([0, 1])           # possible RST
            f[47] = 0                            # no ACK
            f[15] = rng.uniform(1000, 50000)
        elif attack_style == "bruteforce":
            f[0] = rng.choice([22, 21, 3389, 80, 443])
            f[1] = rng.uniform(1e4, 5e5)
            f[2] = rng.integers(20, 500)
            f[3] = rng.integers(20, 500)
            f[4] = rng.uniform(2000, 100000)
            f[5] = rng.uniform(1000, 50000)
            f[14] = rng.uniform(10000, 1e6)
            f[15] = rng.uniform(100, 5000)
        else:  # infiltration
            f[0] = rng.integers(1024, 65535)
            f[1] = rng.uniform(1e6, 1e8)         # very long duration
            f[2] = rng.integers(10, 200)
            f[3] = rng.integers(5, 100)
            f[4] = rng.uniform(5000, 500000)
            f[5] = rng.uniform(2000, 200000)
            f[14] = rng.uniform(100, 10000)
            f[15] = rng.uniform(0.5, 50)

        # Fill remaining features with attack-ish values
        # Fwd packet length stats
        f[6] = rng.uniform(40, 2000)
        f[7] = rng.uniform(0, 40)
        f[8] = rng.uniform(40, 1200)
        f[9] = rng.uniform(0, 800)
        # Bwd packet length stats
        f[10] = rng.uniform(0, 1500)
        f[11] = rng.uniform(0, 40)
        f[12] = rng.uniform(0, 600)
        f[13] = rng.uniform(0, 500)
        # Flow IAT — attacks often have very uniform or zero IAT
        f[16] = rng.uniform(0, 1e4)
        f[17] = rng.uniform(0, 1e3)
        f[18] = rng.uniform(0, 1e5)
        f[19] = rng.uniform(0, 100)
        # Fwd IAT
        f[20] = rng.uniform(0, 1e4)
        f[21] = rng.uniform(0, 5e3)
        f[22] = rng.uniform(0, 1e3)
        f[23] = rng.uniform(0, 1e4)
        f[24] = 0
        # Bwd IAT
        f[25] = rng.uniform(0, 1e4)
        f[26] = rng.uniform(0, 5e3)
        f[27] = rng.uniform(0, 1e3)
        f[28] = rng.uniform(0, 1e4)
        f[29] = 0
        # Flags — attacks often have unusual combos
        f[30] = rng.choice([0, 1])
        f[31] = 0
        f[32] = rng.choice([0, 1], p=[0.7, 0.3])  # URG sometimes set
        f[33] = 0
        f[34] = rng.uniform(20, 120)
        f[35] = rng.uniform(0, 60)
        # Packet Length stats
        f[38] = rng.uniform(0, 40)
        f[39] = rng.uniform(40, 2000)
        f[40] = rng.uniform(40, 1000)
        f[41] = rng.uniform(0, 600)
        f[42] = f[41] ** 2
        # TCP Flags — may have unusual combos
        if f[43] == 0:
            f[43] = rng.choice([0, 1], p=[0.7, 0.3])
        f[48] = rng.choice([0, 1], p=[0.8, 0.2])   # URG
        f[49] = rng.choice([0, 1], p=[0.9, 0.1])
        f[50] = rng.choice([0, 1], p=[0.9, 0.1])
        # Down/Up, Avg sizes
        f[51] = rng.uniform(0, 10)
        f[52] = rng.uniform(40, 1200)
        f[53] = f[8]
        f[54] = f[12]
        f[55] = f[34]
        # Bulk — usually 0
        f[56:62] = 0
        # Subflow
        f[62] = f[2]
        f[63] = f[4]
        f[64] = f[3]
        f[65] = f[5]
        # Init Window bytes — attacks often have anomalous values
        f[66] = rng.choice([0, 1, 256, 512, rng.integers(1, 65535)])
        f[67] = rng.choice([0, 1, 256, rng.integers(1, 65535)])
        f[68] = rng.integers(0, 10)
        f[69] = rng.uniform(0, 40)
        # Active/Idle
        f[70] = rng.uniform(0, 1e4)
        f[71] = rng.uniform(0, 5e3)
        f[72] = rng.uniform(0, 5e4)
        f[73] = 0
        f[74] = rng.uniform(0, 1e5)
        f[75] = rng.uniform(0, 5e4)
        f[76] = rng.uniform(0, 2e5)
        f[77] = 0

        return f

    # ── Window generators ───────────────────────────────

    def generate_flow(self) -> tuple[np.ndarray, int]:
        """
        Generate a single flow and its label.

        Returns
        -------
        (flow_vector, label)  where label is 0=benign, 1=attack
        """
        if self.rng.random() < self.attack_ratio:
            return self._attack_flow(), 1
        return self._benign_flow(), 0

    def generate_window(self, window_size: int = WINDOW_SIZE) -> tuple[np.ndarray, float]:
        """
        Generate a window of *window_size* consecutive flows.

        Returns
        -------
        (window, attack_fraction)
            window: np.ndarray of shape (window_size, 78)
            attack_fraction: fraction of flows that are attacks (0.0–1.0)
        """
        flows = []
        labels = []
        for _ in range(window_size):
            flow, label = self.generate_flow()
            flows.append(flow)
            labels.append(label)
        return np.array(flows, dtype=np.float32), sum(labels) / len(labels)

    def generate_batch(
        self, batch_size: int = 1, window_size: int = WINDOW_SIZE,
    ) -> tuple[np.ndarray, list[float]]:
        """
        Generate a batch of windows.

        Returns
        -------
        (batch, attack_fractions)
            batch: np.ndarray (batch_size, window_size, 78)
            attack_fractions: list of floats per window
        """
        windows = []
        fractions = []
        for _ in range(batch_size):
            w, af = self.generate_window(window_size)
            windows.append(w)
            fractions.append(af)
        return np.array(windows, dtype=np.float32), fractions
