"""
CNN-LSTM IDS model definition.
Shared between FL server and FL clients.
"""

import torch
import torch.nn as nn


class CNN_LSTM_IDS(nn.Module):
    """
    CNN-LSTM hybrid for network intrusion detection.

    Architecture:
        Conv1d(78→64, k=3, pad=1) → ReLU → LSTM(64, 64) → Linear(64→1)

    Input shape : (batch, seq_len=10, num_features=78)
    Output shape: (batch, 1)  — raw logits (apply sigmoid for probability)
    """

    def __init__(self, seq_len: int = 10, num_features: int = 78):
        super().__init__()
        self.seq_len = seq_len
        self.num_features = num_features

        # Spatial feature extraction
        self.conv1 = nn.Conv1d(
            in_channels=num_features,
            out_channels=64,
            kernel_size=3,
            padding=1,
        )
        self.relu = nn.ReLU()

        # Temporal modelling
        self.lstm = nn.LSTM(
            input_size=64,
            hidden_size=64,
            num_layers=1,
            batch_first=True,
        )

        # Classifier (single logit → BCEWithLogitsLoss)
        self.fc = nn.Linear(64, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, T, F) → Conv1d expects (B, F, T)
        x = x.permute(0, 2, 1)
        x = self.relu(self.conv1(x))
        # Back to (B, T, C)
        x = x.permute(0, 2, 1)

        _, (h_n, _) = self.lstm(x)
        h_last = h_n[-1]  # (B, 64)
        out = self.fc(h_last)
        return out


# ── Layer names that are encrypted with CKKS HE ────────────
SELECTED_LAYERS = [
    "lstm.weight_ih_l0",
    "lstm.weight_hh_l0",
    "fc.weight",
    "fc.bias",
]

# ── Default HE parameters ──────────────────────────────────
HE_POLY_MODULUS = 16384
HE_SCALE_BITS = 40
HE_COEFF_MOD_BITS = [60, 40, 40, 40, 40, 60]

# ── Training defaults ──────────────────────────────────────
DEFAULT_CONFIG = {
    "SEED": 42,
    "NUM_CLIENTS": 3,
    "BATCH_SIZE": 128,
    "LOCAL_EPOCHS": 1,
    "ROUNDS": 25,
    "LEARNING_RATE": 1e-3,
    "SEQUENCE_LENGTH": 10,
    "NUM_FEATURES": 78,
    "POS_WEIGHT": 5.0,
    "THRESHOLD": 0.5,
    "MAX_BATCHES": 50,
}
