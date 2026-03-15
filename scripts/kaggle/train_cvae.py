#!/usr/bin/env python3
"""
Kaggle Kernel — CVAE training on CIC-IDS2017 (self-contained, no project imports).

This script is intentionally self-contained: it does NOT import from fl_common/.
All model definitions are duplicated here so the kernel runs on Kaggle without
the project repo being present.

Dataset: syedsharashree/cicids2017-full-15class (full CIC-IDS2017, all 15 attack classes)
  Downloaded automatically via kaggle CLI if not already mounted.

Expected output artifacts (downloaded to model/ after kernel completes):
    cvae_decoder.pt          — decoder weights only (~15MB)
    cvae_class_centroids.pkl — per-class mean latent vectors (<1KB)
    cvae_scaler.pkl          — StandardScaler fit on training data

Estimated runtime: ~3.4 hours on Kaggle P100 GPU (100 epochs, batch=512).

To push this kernel:
    kaggle kernels push -p scripts/kaggle
"""

from __future__ import annotations

import os
import re
import subprocess
import time

import joblib
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F
from sklearn.preprocessing import StandardScaler
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

# ── Kaggle paths ─────────────────────────────────────────────────────────────
# Primary: Kaggle mounts dataset_sources here (read-only)
_MOUNTED_DIR  = "/kaggle/input/cicids2017-full-15class"
# Fallback: writable working directory used when downloading via CLI
_DOWNLOAD_DIR = "/kaggle/working/data"
# Set dynamically by _ensure_dataset() — do not reference before main() runs
DATASET_DIR: str = _MOUNTED_DIR
OUTPUT_DIR = "/kaggle/working"

# ── Hyperparameters ──────────────────────────────────────────────────────────
EPOCHS         = 100   # was 50 — full convergence, we have the time
BATCH_SIZE     = 512
LEARNING_RATE  = 1e-3
WARMUP_EPOCHS  = 30    # was 20 — 30% warmup over 100 epochs, smoother KL ramp
LATENT_DIM     = 128
SEQ_LEN        = 10
NUM_FEATURES   = 78
NUM_CLASSES    = 15
LAMBDA_AUX     = 0.1   # weight for auxiliary classifier loss on z
DATALOADER_WORKERS = 2

CLASS_NAMES: list[str] = [
    "benign",
    "dos hulk",
    "dos goldeneye",
    "dos slowloris",
    "dos slowhttptest",
    "portscan",
    "ddos",
    "ftp patator",
    "ssh patator",
    "bot",
    "infiltration",
    "heartbleed",
    "web attack brute force",
    "web attack xss",
    "web attack sql injection",
]

EXPECTED_FEATURES = [
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


# ══════════════════════════════════════════════════════════════════════════════
#  Model (duplicated from fl_common/cvae.py — keep in sync)
# ══════════════════════════════════════════════════════════════════════════════

class CVAEEncoder(nn.Module):
    """Encodes a traffic window x → (mu, log_var).

    FIX: class label removed from encoder input — the encoder must learn
    class-discriminative representations from the data itself, supervised only
    by the auxiliary classifier on mu.  Passing the class label here caused
    posterior collapse: the decoder learned to ignore z and reconstruct from
    (class_label, noise) alone.

    FIX: LSTM hidden size raised 64 → 128 for richer temporal representation.
    """

    def __init__(self) -> None:
        super().__init__()
        self.conv1 = nn.Conv1d(NUM_FEATURES, 64, kernel_size=3, padding=1)
        self.relu  = nn.ReLU()
        # FIX #2: hidden_size 64 → 128 for richer representation
        self.lstm  = nn.LSTM(input_size=64, hidden_size=128, num_layers=1, batch_first=True)
        # FIX #1 + #2: fc_hidden no longer takes class label (was 64+NUM_CLASSES);
        #              input is now just LSTM hidden state (128)
        self.fc_hidden  = nn.Linear(128, 256)
        self.fc_mu      = nn.Linear(256, LATENT_DIM)
        self.fc_log_var = nn.Linear(256, LATENT_DIM)

    def forward(self, x: torch.Tensor):
        # x: (B, SEQ_LEN, NUM_FEATURES)
        h = self.relu(self.conv1(x.permute(0, 2, 1))).permute(0, 2, 1)
        _, (h_n, _) = self.lstm(h)
        h_last = h_n[-1]                                 # (B, 128)
        h_proj = self.relu(self.fc_hidden(h_last))       # no class concat
        mu      = self.fc_mu(h_proj)
        log_var = self.fc_log_var(h_proj)
        # FIX #3: clamp log_var to prevent exp() overflow in KL loss
        log_var = torch.clamp(log_var, -10.0, 10.0)
        return mu, log_var


class CVAEDecoder(nn.Module):
    """Decodes (z, class_one_hot) → reconstructed traffic window.

    FIX #5: BatchNorm1d added after each hidden ReLU for training stability.
    """

    def __init__(self) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(LATENT_DIM + NUM_CLASSES, 256),
            nn.ReLU(),
            nn.BatchNorm1d(256),          # FIX #5: normalization layer
            nn.Linear(256, 512),
            nn.ReLU(),
            nn.BatchNorm1d(512),          # FIX #5: normalization layer
            nn.Linear(512, SEQ_LEN * NUM_FEATURES),
        )

    def forward(self, z: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        return self.net(torch.cat([z, cond], dim=-1)).view(-1, SEQ_LEN, NUM_FEATURES)


class CVAE(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.encoder        = CVAEEncoder()
        self.decoder        = CVAEDecoder()
        # FIX #6: auxiliary classifier on mu — forces class-discriminative
        # latent space even for rare classes (heartbleed: 11, infiltration: 36)
        self.aux_classifier = nn.Linear(LATENT_DIM, NUM_CLASSES)

    @staticmethod
    def reparameterise(mu, log_var):
        return mu + torch.randn_like(mu) * torch.exp(0.5 * log_var)

    def forward(self, x, cond):
        # FIX #1: encoder takes only x, not (x, cond)
        mu, log_var = self.encoder(x)
        z           = self.reparameterise(mu, log_var)
        return self.decoder(z, cond), mu, log_var


def cvae_loss(recon, x, mu, log_var, beta: float = 1.0):
    recon_loss = F.mse_loss(recon, x, reduction="mean")
    kl_loss    = -0.5 * torch.mean(1.0 + log_var - mu.pow(2) - log_var.exp())
    return recon_loss + beta * kl_loss, recon_loss, kl_loss


# ══════════════════════════════════════════════════════════════════════════════
#  Data
# ══════════════════════════════════════════════════════════════════════════════

def _ensure_dataset() -> None:
    """Locate or download the dataset; sets the global DATASET_DIR.

    Strategy:
      1. Check the Kaggle-mounted path (_MOUNTED_DIR) — available when
         dataset_sources in kernel-metadata.json is honoured (read-only).
      2. Fall back to downloading into _DOWNLOAD_DIR (/kaggle/working/data),
         which is always writable regardless of dataset_sources mounting.
    """
    global DATASET_DIR
    # ── 1. Check mounted path first (fastest, no download needed) ─────────────
    if os.path.isdir(_MOUNTED_DIR):
        csvs = [f for f in os.listdir(_MOUNTED_DIR) if f.endswith(".csv")]
        if csvs:
            print(f"Dataset mounted at {_MOUNTED_DIR} ({len(csvs)} CSV file(s))")
            DATASET_DIR = _MOUNTED_DIR
            return
    # ── 2. Download to writable working dir ───────────────────────────────────
    print(f"Dataset not mounted at {_MOUNTED_DIR} — downloading via kaggle CLI …")
    os.makedirs(_DOWNLOAD_DIR, exist_ok=True)  # /kaggle/working/data is writable
    subprocess.run(
        [
            "kaggle", "datasets", "download",
            "-d", "syedsharashree/cicids2017-full-15class",
            "-p", _DOWNLOAD_DIR,
            "--unzip",
        ],
        check=True,
    )
    DATASET_DIR = _DOWNLOAD_DIR
    print(f"Download complete → {DATASET_DIR}")


def _clean_label(label: str) -> str:
    label = str(label).strip().lower()
    label = re.sub(r"[^a-z0-9\s]", " ", label)
    return re.sub(r"\s+", " ", label).strip()


def _label_to_class_id(label: str) -> int:
    try:
        return CLASS_NAMES.index(label)
    except ValueError:
        return 0


def load_data() -> tuple[np.ndarray, np.ndarray]:
    _ensure_dataset()
    csv_files = sorted([
        os.path.join(DATASET_DIR, f)
        for f in os.listdir(DATASET_DIR) if f.endswith(".csv")
    ])
    print(f"Found {len(csv_files)} CSV files")
    frames = []
    for p in csv_files:
        print(f"  Loading {os.path.basename(p)} …", end=" ", flush=True)
        t0 = time.time()
        df = pd.read_csv(p, low_memory=False)
        df.columns = df.columns.str.strip()
        frames.append(df)
        print(f"{len(df):,} rows ({time.time()-t0:.1f}s)")

    df = pd.concat(frames, ignore_index=True)
    print(f"Total: {len(df):,} rows")

    # Detect label column defensively (handles "Label", "label", " Label ", etc.)
    label_col = next(
        (c for c in df.columns if c.strip().lower() == "label"),
        df.columns[-1],  # fallback: last column (CIC-IDS2017 convention)
    )
    print(f"Label column: '{label_col}'")
    y_raw = df[label_col].apply(_clean_label)
    y = np.array([_label_to_class_id(lbl) for lbl in y_raw], dtype=np.int64)

    print("\nClass distribution:")
    for cid, cname in enumerate(CLASS_NAMES):
        print(f"  [{cid:2d}] {cname:<30s}  {int((y==cid).sum()):>10,}")

    drop_cols = list(dict.fromkeys(
        c for c in ["Flow ID", "Source IP", "Destination IP",
                    "Source Port", "Timestamp", "Label", "_day", label_col]
        if c in df.columns
    ))
    X = df.drop(columns=drop_cols)
    X = X.apply(pd.to_numeric, errors="coerce")
    X.replace([np.inf, -np.inf], np.nan, inplace=True)
    X.fillna(X.median(), inplace=True)
    X.fillna(0, inplace=True)

    for col in EXPECTED_FEATURES:
        if col not in X.columns:
            X[col] = 0.0
    X = X[EXPECTED_FEATURES].astype(np.float32)

    print("\nFitting scaler …")
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X.values).astype(np.float32)
    joblib.dump(scaler, os.path.join(OUTPUT_DIR, "cvae_scaler.pkl"))
    print("cvae_scaler.pkl saved")

    return X_scaled, y


class TrafficWindowDataset(Dataset):
    """Sliding-window dataset — windows generated on-the-fly to avoid OOM.

    Storing all windows at once (sliding_window_view + copy) would allocate
    ~8.7 GB for 2.8 M rows.  Generating on-the-fly keeps memory at ~874 MB.

    self.X  : (N, NUM_FEATURES)          — raw scaled features, no window copy
    self.y  : (N - SEQ_LEN + 1,)         — per-window label (last row of window)
    """

    def __init__(self, X: np.ndarray, y: np.ndarray) -> None:
        self.X = torch.from_numpy(X)                         # (N, NUM_FEATURES)
        self.y = torch.from_numpy(y[SEQ_LEN - 1:].copy())   # (n_windows,)
        self.n = len(X) - SEQ_LEN + 1

    def __len__(self) -> int:
        return self.n

    def __getitem__(self, idx: int):
        # Returns window (SEQ_LEN, NUM_FEATURES) and its label
        return self.X[idx : idx + SEQ_LEN], self.y[idx]


# ══════════════════════════════════════════════════════════════════════════════
#  Training
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")
    if device.type == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")

    X_scaled, y_arr = load_data()
    dataset = TrafficWindowDataset(X_scaled, y_arr)

    class_counts   = torch.bincount(dataset.y, minlength=NUM_CLASSES).float().clamp(min=1.0)
    sample_weights = (1.0 / class_counts)[dataset.y]
    sampler        = WeightedRandomSampler(sample_weights, len(sample_weights), replacement=True)

    loader = DataLoader(
        dataset, batch_size=BATCH_SIZE, sampler=sampler,
        num_workers=DATALOADER_WORKERS, pin_memory=(device.type == "cuda"), drop_last=True,
    )
    print(f"\nWindows: {len(dataset):,}  |  Batches/epoch: {len(loader)}")

    model     = CVAE().to(device)
    optimiser = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    # T_max tracks EPOCHS so the cosine schedule stays correct at any epoch count
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimiser, T_max=EPOCHS, eta_min=1e-5
    )

    # FIX #4: track best reconstruction loss (not total_loss which is biased by
    # the beta annealing — during warmup total_loss ≈ recon_loss and an early
    # checkpoint at epoch 1 would always "win").  We only start tracking after
    # warmup so the saved model has proper KL regularisation in effect.
    best_recon_loss = float("inf")

    for epoch in range(1, EPOCHS + 1):
        # FIX #7/#8: 100 epochs, 30-epoch warmup
        beta = min(1.0, epoch / WARMUP_EPOCHS)
        model.train()
        total_loss = recon_sum = kl_sum = aux_sum = 0.0
        t0 = time.time()

        for x_batch, y_batch in loader:
            x_batch  = x_batch.to(device)
            y_device = y_batch.to(device)
            cond     = F.one_hot(y_device, num_classes=NUM_CLASSES).float()

            recon, mu, log_var = model(x_batch, cond)
            loss, r_loss, kl   = cvae_loss(recon, x_batch, mu, log_var, beta=beta)

            # FIX #6: auxiliary classifier loss — forces mu to be class-discriminative
            aux_loss  = F.cross_entropy(model.aux_classifier(mu), y_device)
            loss      = loss + LAMBDA_AUX * aux_loss

            optimiser.zero_grad()
            loss.backward()
            # FIX #10: tighter gradient clipping (was 5.0) for VAE stability
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimiser.step()

            total_loss += loss.item()
            recon_sum  += r_loss.item()
            kl_sum     += kl.item()
            aux_sum    += aux_loss.item()

        scheduler.step()
        n = len(loader)
        print(
            f"Epoch {epoch:3d}/{EPOCHS}  "
            f"loss={total_loss/n:.5f}  recon={recon_sum/n:.5f}  "
            f"kl={kl_sum/n:.5f}  aux={aux_sum/n:.5f}  "
            f"beta={beta:.3f}  ({time.time()-t0:.1f}s)"
        )

        # FIX #4: save on best recon_loss, only after warmup is complete
        if epoch >= WARMUP_EPOCHS and recon_sum / n < best_recon_loss:
            best_recon_loss = recon_sum / n
            torch.save(
                model.decoder.state_dict(),
                os.path.join(OUTPUT_DIR, "cvae_decoder.pt"),
            )
            print(f"  * Best recon={best_recon_loss:.5f} — cvae_decoder.pt saved")

    # ── per-class centroids ──────────────────────────────────────────────────
    print("\nComputing per-class latent centroids …")
    model.eval()
    centroids: dict[int, np.ndarray] = {}
    with torch.no_grad():
        for class_id in range(NUM_CLASSES):
            mask = dataset.y == class_id
            if mask.sum() == 0:
                centroids[class_id] = np.zeros(LATENT_DIM, dtype=np.float32)
                continue
            idx = torch.where(mask)[0]
            if len(idx) > 2000:
                idx = idx[torch.randperm(len(idx))[:2000]]
            # idx are window indices; build (k, SEQ_LEN, NUM_FEATURES) via advanced indexing
            row_idx = idx.unsqueeze(1) + torch.arange(SEQ_LEN)  # (k, SEQ_LEN)
            x_sub   = dataset.X[row_idx].to(device)             # (k, SEQ_LEN, NUM_FEATURES)
            # FIX #9: encoder no longer takes class label — call without cond_sub
            mu, _   = model.encoder(x_sub)
            centroids[class_id] = mu.mean(dim=0).cpu().numpy()

    joblib.dump(centroids, os.path.join(OUTPUT_DIR, "cvae_class_centroids.pkl"))
    print("cvae_class_centroids.pkl saved")
    print(f"\nDone. Best recon loss (post-warmup): {best_recon_loss:.5f}")
    print("Output files:")
    for f in ["cvae_decoder.pt", "cvae_class_centroids.pkl", "cvae_scaler.pkl"]:
        p    = os.path.join(OUTPUT_DIR, f)
        size = os.path.getsize(p) / 1e6 if os.path.exists(p) else 0
        print(f"  {f}  ({size:.2f} MB)")


if __name__ == "__main__":
    main()
