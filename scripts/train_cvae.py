#!/usr/bin/env python3
"""
Local CVAE training script for CIC-IDS2017 synthetic traffic generation.

Trains a Conditional VAE whose encoder mirrors the CNN_LSTM_IDS architecture.
Saves two artifacts to model/:
    cvae_decoder.pt          — decoder weights (loaded at runtime by data_service.py)
    cvae_class_centroids.pkl — per-class mean latent vectors (used by generate_novel_attacks.py)

Usage:
    python scripts/train_cvae.py                        # defaults
    python scripts/train_cvae.py --epochs 60 --batch 512
    python scripts/train_cvae.py --device cuda          # explicit GPU

Requirements:
    pip install torch pandas scikit-learn joblib tqdm
    datasets/cicids2017/  must contain the 8 CIC-IDS2017 CSV files.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F
from sklearn.preprocessing import StandardScaler
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from tqdm import tqdm

# ── project imports ──────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from fl_common.cvae import CVAE, CLASS_NAMES, NUM_CLASSES, cvae_loss  # noqa: E402

# ── paths ────────────────────────────────────────────────────────────────────
DATASET_DIR = PROJECT_ROOT / "datasets" / "cicids2017"
MODEL_DIR = PROJECT_ROOT / "model"
SCALER_OUT = MODEL_DIR / "cvae_scaler.pkl"
DECODER_OUT = MODEL_DIR / "cvae_decoder.pt"
CENTROIDS_OUT = MODEL_DIR / "cvae_class_centroids.pkl"

# ── CIC-IDS2017 feature order (matches preprocess_cicids2017.py) ─────────────
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
#  Data loading
# ══════════════════════════════════════════════════════════════════════════════

def _clean_label(label: str) -> str:
    label = str(label).strip().lower()
    label = re.sub(r"[^a-z0-9\s]", " ", label)
    return re.sub(r"\s+", " ", label).strip()


def _label_to_class_id(label: str) -> int:
    """Map a cleaned CIC-IDS2017 label string to a 0-14 class index."""
    try:
        return CLASS_NAMES.index(label)
    except ValueError:
        # Any unrecognised label maps to benign (0)
        return 0


def load_and_preprocess() -> tuple[np.ndarray, np.ndarray, StandardScaler]:
    """
    Load all CIC-IDS2017 CSVs, extract 78 features + 15-class labels.
    Fits and saves cvae_scaler.pkl (independent of standard_scaler.pkl).

    Returns:
        X_scaled : (N, 78) float32
        y        : (N,) int64 — class indices 0-14
        scaler   : fitted StandardScaler
    """
    csv_files = sorted(DATASET_DIR.glob("*.csv"))
    if not csv_files:
        print(f"ERROR: No CSV files found in {DATASET_DIR}")
        sys.exit(1)

    print(f"Loading {len(csv_files)} CSV files from {DATASET_DIR} …")
    frames = []
    for p in csv_files:
        print(f"  {p.name} … ", end="", flush=True)
        t0 = time.time()
        df = pd.read_csv(str(p), low_memory=False)
        df.columns = df.columns.str.strip()
        frames.append(df)
        print(f"{len(df):,} rows  ({time.time()-t0:.1f}s)")

    df = pd.concat(frames, ignore_index=True)
    print(f"\nMerged: {len(df):,} rows")

    # Labels
    y_raw = df["Label"].apply(_clean_label)
    y = np.array([_label_to_class_id(lbl) for lbl in y_raw], dtype=np.int64)

    print("\nClass distribution:")
    for cid, cname in enumerate(CLASS_NAMES):
        count = int((y == cid).sum())
        print(f"  [{cid:2d}] {cname:<30s}  {count:>10,}")

    # Features
    drop_cols = [c for c in ["Flow ID", "Source IP", "Destination IP",
                               "Source Port", "Timestamp", "Label", "_day"]
                 if c in df.columns]
    X = df.drop(columns=drop_cols)
    X = X.apply(pd.to_numeric, errors="coerce")
    X.replace([np.inf, -np.inf], np.nan, inplace=True)
    X.fillna(X.median(), inplace=True)
    X.fillna(0, inplace=True)

    # Ensure 78 canonical features
    for col in EXPECTED_FEATURES:
        if col not in X.columns:
            X[col] = 0.0
    X = X[EXPECTED_FEATURES].astype(np.float32)

    # Fit CVAE-specific scaler (NOT the same as standard_scaler.pkl)
    print("\nFitting cvae_scaler …")
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X.values).astype(np.float32)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(scaler, str(SCALER_OUT))
    print(f"Saved: {SCALER_OUT}")

    return X_scaled, y, scaler


# ══════════════════════════════════════════════════════════════════════════════
#  Dataset
# ══════════════════════════════════════════════════════════════════════════════

class TrafficWindowDataset(Dataset):
    """
    Wraps (N, 78) flat features into (N, SEQ_LEN=10, 78) sliding windows.
    Label is the class of the *last* row in each window (mirrors FL client logic).
    """

    def __init__(self, X: np.ndarray, y: np.ndarray, seq_len: int = 10) -> None:
        self.seq_len = seq_len
        n = len(X)
        # Build all windows at once (uses stride_tricks — no copy)
        wins = np.lib.stride_tricks.sliding_window_view(X, (seq_len, X.shape[1]))
        self.X = torch.from_numpy(wins.squeeze(1).copy())      # (W, seq_len, 78)
        self.y = torch.from_numpy(y[seq_len - 1:].copy())       # (W,) int64

    def __len__(self) -> int:
        return len(self.X)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor]:
        return self.X[idx], self.y[idx]


# ══════════════════════════════════════════════════════════════════════════════
#  Training loop
# ══════════════════════════════════════════════════════════════════════════════

def make_weighted_sampler(y: torch.Tensor) -> WeightedRandomSampler:
    """Upsample rare classes so every class appears equally per epoch."""
    class_counts = torch.bincount(y, minlength=NUM_CLASSES).float()
    # Avoid division by zero for classes with 0 samples
    class_counts = torch.clamp(class_counts, min=1.0)
    class_weights = 1.0 / class_counts
    sample_weights = class_weights[y]
    return WeightedRandomSampler(
        weights=sample_weights,
        num_samples=len(sample_weights),
        replacement=True,
    )


def kl_annealing_beta(epoch: int, warmup_epochs: int = 20) -> float:
    """Linear KL warmup: 0.0 → 1.0 over first `warmup_epochs` epochs."""
    return min(1.0, epoch / max(warmup_epochs, 1))


def train(args: argparse.Namespace) -> None:
    device = torch.device(args.device if torch.cuda.is_available() else "cpu")
    print(f"\nDevice: {device}")

    # ── data ────────────────────────────────────────────────────────────────
    X_scaled, y_arr, _ = load_and_preprocess()
    dataset = TrafficWindowDataset(X_scaled, y_arr, seq_len=10)

    sampler = make_weighted_sampler(dataset.y)
    loader = DataLoader(
        dataset,
        batch_size=args.batch,
        sampler=sampler,
        num_workers=args.workers,
        pin_memory=(device.type == "cuda"),
        drop_last=True,
    )
    print(f"\nDataset: {len(dataset):,} windows  |  Batches/epoch: {len(loader)}")

    # ── model ────────────────────────────────────────────────────────────────
    model = CVAE().to(device)
    optimiser = torch.optim.Adam(model.parameters(), lr=args.lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimiser, T_max=args.epochs, eta_min=1e-5
    )

    # ── training ─────────────────────────────────────────────────────────────
    best_loss = float("inf")
    for epoch in range(1, args.epochs + 1):
        beta = kl_annealing_beta(epoch, warmup_epochs=20)
        model.train()
        total_loss = recon_sum = kl_sum = 0.0
        t0 = time.time()

        for x_batch, y_batch in tqdm(loader, desc=f"Epoch {epoch:3d}/{args.epochs}",
                                      leave=False, disable=not args.verbose):
            x_batch = x_batch.to(device)
            cond = F.one_hot(y_batch.to(device), num_classes=NUM_CLASSES).float()

            recon, mu, log_var = model(x_batch, cond)
            loss, r_loss, kl_loss = cvae_loss(recon, x_batch, mu, log_var, beta=beta)

            optimiser.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimiser.step()

            total_loss += loss.item()
            recon_sum += r_loss.item()
            kl_sum += kl_loss.item()

        scheduler.step()
        n_batches = len(loader)
        avg_total = total_loss / n_batches
        avg_recon = recon_sum / n_batches
        avg_kl = kl_sum / n_batches
        elapsed = time.time() - t0

        print(
            f"Epoch {epoch:3d}/{args.epochs}  "
            f"loss={avg_total:.5f}  recon={avg_recon:.5f}  kl={avg_kl:.5f}  "
            f"beta={beta:.3f}  lr={scheduler.get_last_lr()[0]:.2e}  "
            f"({elapsed:.1f}s)"
        )

        if avg_total < best_loss:
            best_loss = avg_total
            torch.save(model.decoder.state_dict(), str(DECODER_OUT))
            print(f"  * Best — decoder saved: {DECODER_OUT}")

    # ── compute per-class centroids ──────────────────────────────────────────
    print("\nComputing per-class latent centroids …")
    model.eval()
    centroids: dict[int, np.ndarray] = {}
    with torch.no_grad():
        for class_id in range(NUM_CLASSES):
            mask = dataset.y == class_id
            if mask.sum() == 0:
                centroids[class_id] = np.zeros(128, dtype=np.float32)
                continue
            # Sample up to 2000 windows for speed
            idx = torch.where(mask)[0]
            if len(idx) > 2000:
                idx = idx[torch.randperm(len(idx))[:2000]]
            x_sub = dataset.X[idx].to(device)
            cond_sub = F.one_hot(
                torch.full((len(idx),), class_id, dtype=torch.long, device=device),
                num_classes=NUM_CLASSES,
            ).float()
            mu, _ = model.encoder(x_sub, cond_sub)
            centroids[class_id] = mu.mean(dim=0).cpu().numpy()
        print(f"  Computed centroids for {len(centroids)} classes")

    joblib.dump(centroids, str(CENTROIDS_OUT))
    print(f"Saved: {CENTROIDS_OUT}")
    print(f"\nDone. Best loss: {best_loss:.5f}")
    print(f"  Decoder  : {DECODER_OUT}")
    print(f"  Centroids: {CENTROIDS_OUT}")


# ══════════════════════════════════════════════════════════════════════════════
#  CLI
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="Train CVAE on CIC-IDS2017")
    parser.add_argument("--epochs", type=int, default=50, help="Training epochs (default: 50)")
    parser.add_argument("--batch", type=int, default=256, help="Batch size (default: 256)")
    parser.add_argument("--lr", type=float, default=1e-3, help="Learning rate (default: 1e-3)")
    parser.add_argument("--device", type=str, default="cuda", help="Device: cuda or cpu")
    parser.add_argument("--workers", type=int, default=4, help="DataLoader workers (default: 4)")
    parser.add_argument("--verbose", action="store_true", help="Show per-batch progress bar")
    args = parser.parse_args()
    train(args)


if __name__ == "__main__":
    main()
