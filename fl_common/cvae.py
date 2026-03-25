"""
Conditional Variational Autoencoder (CVAE) for synthetic IoT traffic generation.

Architecture (v7 — synced with Kaggle training script):

    Encoder : Conv1d(78→64, k=3) → LSTM(64, hidden=128) → FC(128→256) → (mu, log_var)
              NOTE: class label is NOT fed to the encoder — this prevents posterior
              collapse where the decoder learns to ignore z.  Class separation is
              enforced only by the auxiliary classifier loss on mu during training.

    Decoder : Linear(128+15→256) → ReLU → BN(256)
                → Linear(256→512) → ReLU → BN(512)
                → Linear(512→780) → reshape(10, 78)

Condition vector: one-hot over 15 CIC-IDS2017 attack classes (see CLASS_NAMES).

Usage (inference only — training is done offline on Kaggle):
    from fl_common.cvae import CVAEDecoder, CLASS_NAMES
    decoder = CVAEDecoder()
    decoder.load_state_dict(torch.load("model/cvae_decoder.pt", map_location="cpu"))
    decoder.eval()
    z = torch.randn(batch, 128)
    cond = F.one_hot(torch.tensor([class_id]*batch), num_classes=15).float()
    samples = decoder(z, cond)   # (batch, 10, 78)
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

# ── 15-class label map  (matches train_cvae.py CLASS_NAMES) ──────────────────
CLASS_NAMES: list[str] = [
    "benign",                    # 0  — 2,273,097 rows
    "dos hulk",                  # 1  —   231,073
    "dos goldeneye",             # 2  —    10,293
    "dos slowloris",             # 3  —     5,796
    "dos slowhttptest",          # 4  —     5,499
    "portscan",                  # 5  —   158,930
    "ddos",                      # 6  —   128,027
    "ftp patator",               # 7  —     7,938
    "ssh patator",               # 8  —     5,897
    "bot",                       # 9  —     1,966
    "infiltration",              # 10 —        36  ← rare
    "heartbleed",                # 11 —        11  ← rare
    "web attack brute force",    # 12 —     1,507
    "web attack xss",            # 13 —       652
    "web attack sql injection",  # 14 —        21  ← rare
]

NUM_CLASSES: int = len(CLASS_NAMES)   # 15
SEQ_LEN: int = 10
NUM_FEATURES: int = 78
LATENT_DIM: int = 128

# ── CIC-IDS2017 feature names (column order as preprocessed) ─────────────────
# Index i corresponds to position i in the 78-element feature vector.
FEATURE_NAMES: list[str] = [
    "Destination Port",           #  0
    "Flow Duration",              #  1
    "Total Fwd Packets",          #  2
    "Total Backward Packets",     #  3
    "Total Length of Fwd Packets",  #  4
    "Total Length of Bwd Packets",  #  5
    "Fwd Packet Length Max",      #  6
    "Fwd Packet Length Min",      #  7
    "Fwd Packet Length Mean",     #  8
    "Fwd Packet Length Std",      #  9
    "Bwd Packet Length Max",      # 10
    "Bwd Packet Length Min",      # 11
    "Bwd Packet Length Mean",     # 12
    "Bwd Packet Length Std",      # 13
    "Flow Bytes/s",               # 14
    "Flow Packets/s",             # 15
    "Flow IAT Mean",              # 16
    "Flow IAT Std",               # 17
    "Flow IAT Max",               # 18
    "Flow IAT Min",               # 19
    "Fwd IAT Total",              # 20
    "Fwd IAT Mean",               # 21
    "Fwd IAT Std",                # 22
    "Fwd IAT Max",                # 23
    "Fwd IAT Min",                # 24
    "Bwd IAT Total",              # 25
    "Bwd IAT Mean",               # 26
    "Bwd IAT Std",                # 27
    "Bwd IAT Max",                # 28
    "Bwd IAT Min",                # 29
    "Fwd PSH Flags",              # 30
    "Bwd PSH Flags",              # 31
    "Fwd URG Flags",              # 32
    "Bwd URG Flags",              # 33
    "Fwd Header Length",          # 34
    "Bwd Header Length",          # 35
    "Fwd Packets/s",              # 36
    "Bwd Packets/s",              # 37
    "Min Packet Length",          # 38
    "Max Packet Length",          # 39
    "Packet Length Mean",         # 40
    "Packet Length Std",          # 41
    "Packet Length Variance",     # 42
    "FIN Flag Count",             # 43
    "SYN Flag Count",             # 44
    "RST Flag Count",             # 45
    "PSH Flag Count",             # 46
    "ACK Flag Count",             # 47
    "URG Flag Count",             # 48
    "CWE Flag Count",             # 49
    "ECE Flag Count",             # 50
    "Down/Up Ratio",              # 51
    "Average Packet Size",        # 52
    "Avg Fwd Segment Size",       # 53
    "Avg Bwd Segment Size",       # 54
    "Fwd Header Length.1",        # 55
    "Fwd Avg Bytes/Bulk",         # 56
    "Fwd Avg Packets/Bulk",       # 57
    "Fwd Avg Bulk Rate",          # 58
    "Bwd Avg Bytes/Bulk",         # 59
    "Bwd Avg Packets/Bulk",       # 60
    "Bwd Avg Bulk Rate",          # 61
    "Subflow Fwd Packets",        # 62
    "Subflow Fwd Bytes",          # 63
    "Subflow Bwd Packets",        # 64
    "Subflow Bwd Bytes",          # 65
    "Init_Win_bytes_forward",     # 66
    "Init_Win_bytes_backward",    # 67
    "act_data_pkt_fwd",           # 68
    "min_seg_size_forward",       # 69
    "Active Mean",                # 70
    "Active Std",                 # 71
    "Active Max",                 # 72
    "Active Min",                 # 73
    "Idle Mean",                  # 74
    "Idle Std",                   # 75
    "Idle Max",                   # 76
    "Idle Min",                   # 77
]


# ══════════════════════════════════════════════════════════════════════════════
#  Encoder  (used only during offline Kaggle training — not shipped at runtime)
# ══════════════════════════════════════════════════════════════════════════════

class CVAEEncoder(nn.Module):
    """
    Encodes a traffic window (B, T=10, F=78) → (mu, log_var).

    Class label is intentionally excluded from the encoder input.
    Feeding the class here caused posterior collapse in earlier versions: the
    decoder learned to reconstruct from (class, noise) and ignored z entirely.
    Class-discriminative structure is enforced by an auxiliary classifier on mu
    during training only.

    Architecture:
        Conv1d(78→64, k=3, pad=1) → ReLU
        LSTM(64, hidden=128, layers=1)
        Linear(128→256) → ReLU
        Linear(256→latent_dim)  [mu]
        Linear(256→latent_dim)  [log_var, clamped ±10]
    """

    def __init__(
        self,
        num_features: int = NUM_FEATURES,
        latent_dim: int = LATENT_DIM,
    ) -> None:
        super().__init__()
        self.latent_dim = latent_dim

        self.conv1 = nn.Conv1d(num_features, 64, kernel_size=3, padding=1)
        self.relu = nn.ReLU()
        # hidden_size raised 64→128 for richer temporal representation
        self.lstm = nn.LSTM(input_size=64, hidden_size=128, num_layers=1, batch_first=True)
        # No class label concatenated here (was 64+num_classes in old version)
        self.fc_hidden = nn.Linear(128, 256)
        self.fc_mu = nn.Linear(256, latent_dim)
        self.fc_log_var = nn.Linear(256, latent_dim)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """
        Args:
            x : (B, T, F) float32 — scaled traffic window

        Returns:
            mu      : (B, latent_dim)
            log_var : (B, latent_dim)  clamped to [-10, 10]
        """
        h = self.relu(self.conv1(x.permute(0, 2, 1))).permute(0, 2, 1)  # (B, T, 64)
        _, (h_n, _) = self.lstm(h)
        h_last = h_n[-1]                              # (B, 128)
        h_proj = self.relu(self.fc_hidden(h_last))    # (B, 256)
        mu = self.fc_mu(h_proj)
        log_var = torch.clamp(self.fc_log_var(h_proj), -10.0, 10.0)
        return mu, log_var


# ══════════════════════════════════════════════════════════════════════════════
#  Decoder  (the only artifact needed at inference time)
# ══════════════════════════════════════════════════════════════════════════════

class CVAEDecoder(nn.Module):
    """
    Decodes (z, cond) → synthetic traffic window (B, T=10, F=78).

    BatchNorm1d layers added after each hidden ReLU for training stability.
    Only this module is saved as cvae_decoder.pt and used at inference time.

    Architecture:
        Linear(128+15→256) → ReLU → BN(256)
        Linear(256→512)    → ReLU → BN(512)
        Linear(512→780)    → reshape(B, 10, 78)
    """

    def __init__(
        self,
        seq_len: int = SEQ_LEN,
        num_features: int = NUM_FEATURES,
        num_classes: int = NUM_CLASSES,
        latent_dim: int = LATENT_DIM,
    ) -> None:
        super().__init__()
        self.seq_len = seq_len
        self.num_features = num_features
        self.output_dim = seq_len * num_features  # 780

        self.net = nn.Sequential(
            nn.Linear(latent_dim + num_classes, 256),
            nn.ReLU(),
            nn.BatchNorm1d(256),
            nn.Linear(256, 512),
            nn.ReLU(),
            nn.BatchNorm1d(512),
            nn.Linear(512, self.output_dim),
        )

    def forward(self, z: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        """
        Args:
            z    : (B, latent_dim)
            cond : (B, num_classes) float32 one-hot

        Returns:
            out  : (B, T, F) — reconstructed / generated traffic window
        """
        flat = self.net(torch.cat([z, cond], dim=-1))   # (B, T*F)
        return flat.view(-1, self.seq_len, self.num_features)


# ══════════════════════════════════════════════════════════════════════════════
#  Full CVAE (offline Kaggle training only)
# ══════════════════════════════════════════════════════════════════════════════

class CVAE(nn.Module):
    """
    Full CVAE used only during offline training on Kaggle.
    At inference we load only the CVAEDecoder weights.
    """

    def __init__(
        self,
        seq_len: int = SEQ_LEN,
        num_features: int = NUM_FEATURES,
        num_classes: int = NUM_CLASSES,
        latent_dim: int = LATENT_DIM,
    ) -> None:
        super().__init__()
        self.encoder = CVAEEncoder(num_features, latent_dim)
        self.decoder = CVAEDecoder(seq_len, num_features, num_classes, latent_dim)
        self.aux_classifier = nn.Linear(latent_dim, num_classes)

    @staticmethod
    def reparameterise(mu: torch.Tensor, log_var: torch.Tensor) -> torch.Tensor:
        """Sample z ~ N(mu, exp(log_var)) using the reparameterisation trick."""
        return mu + torch.randn_like(mu) * torch.exp(0.5 * log_var)

    def forward(
        self, x: torch.Tensor, cond: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Returns:
            recon   : (B, T, F) — reconstructed window
            mu      : (B, latent_dim)
            log_var : (B, latent_dim)
        """
        mu, log_var = self.encoder(x)          # class label NOT passed to encoder
        z = self.reparameterise(mu, log_var)
        recon = self.decoder(z, cond)
        return recon, mu, log_var


# ══════════════════════════════════════════════════════════════════════════════
#  Loss
# ══════════════════════════════════════════════════════════════════════════════

def cvae_loss(
    recon: torch.Tensor,
    x: torch.Tensor,
    mu: torch.Tensor,
    log_var: torch.Tensor,
    beta: float = 1.0,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """
    ELBO loss: reconstruction (MSE) + beta * KL divergence.

    beta < 1 during warmup (KL annealing) to avoid posterior collapse.

    Returns:
        total_loss : scalar
        recon_loss : scalar (for logging)
        kl_loss    : scalar (for logging)
    """
    recon_loss = F.mse_loss(recon, x, reduction="mean")
    kl_loss = -0.5 * torch.mean(1.0 + log_var - mu.pow(2) - log_var.exp())
    return recon_loss + beta * kl_loss, recon_loss, kl_loss
