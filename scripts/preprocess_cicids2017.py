#!/usr/bin/env python3
"""
CIC-IDS2017 Dataset Preprocessing Script
=========================================
Reads all 8 CSV files from datasets/cicids2017/, cleans, scales, creates
sliding windows, and partitions across N federated-learning clients.

Output structure (per client):
    data/clients/<client_id>/X_seq_chunk_0.npy   (float32, shape [N, 10, 78])
    data/clients/<client_id>/y_seq_chunk_0.npy   (int64,   shape [N])

Also saves:
    backend/models/standard_scaler.pkl           (fitted StandardScaler)

Usage:
    python scripts/preprocess_cicids2017.py                   # defaults
    python scripts/preprocess_cicids2017.py --window 10 --stride 5
    python scripts/preprocess_cicids2017.py --clients 2       # 2-client split
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
from sklearn.preprocessing import StandardScaler

# ── paths ────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATASET_DIR = PROJECT_ROOT / "datasets" / "cicids2017"
CLIENT_DATA_DIR = PROJECT_ROOT / "data" / "clients"
SCALER_OUT = PROJECT_ROOT / "backend" / "models" / "standard_scaler.pkl"

# ── CSV file ↔ day mapping ───────────────────────────────
# The CIC-IDS2017 dataset has 8 CSV files captured across 5 days.
CSV_FILES = {
    "Monday-WorkingHours.pcap_ISCX.csv":                          "monday",
    "Tuesday-WorkingHours.pcap_ISCX.csv":                         "tuesday",
    "Wednesday-workingHours.pcap_ISCX.csv":                       "wednesday",
    "Thursday-WorkingHours-Morning-WebAttacks.pcap_ISCX.csv":     "thursday",
    "Thursday-WorkingHours-Afternoon-Infilteration.pcap_ISCX.csv":"thursday",
    "Friday-WorkingHours-Morning.pcap_ISCX.csv":                  "friday",
    "Friday-WorkingHours-Afternoon-PortScan.pcap_ISCX.csv":       "friday",
    "Friday-WorkingHours-Afternoon-DDos.pcap_ISCX.csv":           "friday",
}

# Default client partition: which days each client gets.
DEFAULT_CLIENT_PARTITION: dict[str, list[str]] = {
    "bank_a": ["monday", "tuesday"],
    "bank_b": ["wednesday", "thursday"],
    "bank_c": ["friday"],
}

# 78 expected feature columns (after pandas handles duplicate col names).
# This order matches the traffic simulator and the CNN-LSTM model.
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

assert len(EXPECTED_FEATURES) == 78, f"Expected 78 features, got {len(EXPECTED_FEATURES)}"


# ═════════════════════════════════════════════════════════
#  Step 1 — Load & merge all CSVs
# ═════════════════════════════════════════════════════════
def load_csvs() -> pd.DataFrame:
    """Load all 8 CIC-IDS2017 CSV files, tag each row with its day."""
    frames: list[pd.DataFrame] = []
    for fname, day in CSV_FILES.items():
        path = DATASET_DIR / fname
        if not path.exists():
            print(f"  ⚠  Missing: {fname} — skipping")
            continue
        print(f"  Loading {fname} …", end=" ", flush=True)
        t0 = time.time()
        df = pd.read_csv(str(path), low_memory=False)
        df.columns = df.columns.str.strip()            # remove leading/trailing spaces
        df["_day"] = day
        frames.append(df)
        print(f"{len(df):,} rows  ({time.time()-t0:.1f}s)")

    if not frames:
        print("ERROR: No CSV files found in", DATASET_DIR)
        sys.exit(1)

    merged = pd.concat(frames, axis=0, ignore_index=True)
    print(f"\n  Merged dataset: {merged.shape[0]:,} rows × {merged.shape[1]} cols")
    return merged


# ═════════════════════════════════════════════════════════
#  Step 2 — Clean
# ═════════════════════════════════════════════════════════
def clean_label(label: str) -> str:
    label = str(label).strip().lower()
    label = re.sub(r"[^a-z0-9\s]", " ", label)
    label = re.sub(r"\s+", " ", label).strip()
    return label


def clean_data(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """
    Remove non-feature columns, handle NaN/inf, drop constant columns,
    encode labels as binary (BENIGN=0, attack=1).

    Returns (X_df, y_series) where X_df has exactly 78 feature columns.
    """
    # --- Labels --------------------------------------------------------
    if "Label" not in df.columns:
        print("ERROR: 'Label' column not found. Columns:", list(df.columns))
        sys.exit(1)

    y_raw = df["Label"].apply(clean_label)
    y = y_raw.apply(lambda x: 0 if x == "benign" else 1).astype(np.int64)
    print(f"\n  Label distribution:")
    print(f"    Benign : {(y == 0).sum():>10,}")
    print(f"    Attack : {(y == 1).sum():>10,}")

    # --- Drop non-feature columns --------------------------------------
    drop_cols = [
        c for c in ["Flow ID", "Source IP", "Destination IP",
                     "Source Port", "Timestamp", "Label", "_day"]
        if c in df.columns
    ]
    X = df.drop(columns=drop_cols)

    # --- Force numeric --------------------------------------------------
    X = X.apply(pd.to_numeric, errors="coerce")

    # --- Replace inf → NaN, then fill NaN with column median -----------
    X.replace([np.inf, -np.inf], np.nan, inplace=True)
    nan_before = int(X.isna().sum().sum())
    X.fillna(X.median(), inplace=True)
    nan_after = int(X.isna().sum().sum())
    print(f"\n  NaN values: {nan_before:,} → {nan_after} (after median fill)")

    # Any remaining NaN (all-NaN column) → fill with 0
    X.fillna(0, inplace=True)

    # --- Remove constant columns ----------------------------------------
    constant_cols = [c for c in X.columns if X[c].nunique() <= 1]
    if constant_cols:
        print(f"  Dropping {len(constant_cols)} constant column(s): {constant_cols}")
        X.drop(columns=constant_cols, inplace=True)

    # --- Ensure we have the expected 78 features -----------------------
    # After pandas reads the CSV, "Fwd Header Length" appears twice.
    # pandas auto-renames the second to "Fwd Header Length.1".
    available = set(X.columns)
    expected = set(EXPECTED_FEATURES)

    missing = expected - available
    extra = available - expected

    if missing:
        print(f"  ⚠  Missing features (will be zero-filled): {sorted(missing)}")
        for col in missing:
            X[col] = 0.0

    if extra:
        print(f"  Dropping {len(extra)} extra column(s): {sorted(extra)}")
        X.drop(columns=list(extra), inplace=True)

    # Reorder to canonical order
    X = X[EXPECTED_FEATURES].astype(np.float32)
    print(f"  Final feature matrix: {X.shape[0]:,} rows × {X.shape[1]} features")

    # --- Align indices after any dropped rows --------------------------
    mask = X.notna().all(axis=1)
    X = X[mask].reset_index(drop=True)
    y = y[mask].reset_index(drop=True)

    return X, y


# ═════════════════════════════════════════════════════════
#  Step 3 — Scale
# ═════════════════════════════════════════════════════════
def fit_and_scale(X: pd.DataFrame) -> np.ndarray:
    """Fit StandardScaler on full dataset, save scaler, return scaled array."""
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X.values)

    SCALER_OUT.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(scaler, str(SCALER_OUT))
    print(f"\n  Scaler saved → {SCALER_OUT}")
    print(f"  Mean (first 5): {X_scaled.mean(axis=0)[:5].round(6)}")
    print(f"  Std  (first 5): {X_scaled.std(axis=0)[:5].round(6)}")

    assert not np.isnan(X_scaled).any(), "NaN found after scaling!"
    assert not np.isinf(X_scaled).any(), "Inf found after scaling!"
    return X_scaled


# ═════════════════════════════════════════════════════════
#  Step 4 — Sliding windows
# ═════════════════════════════════════════════════════════
def create_windows(
    X: np.ndarray, y: np.ndarray, window: int, stride: int
) -> tuple[np.ndarray, np.ndarray]:
    """Create sliding windows of shape (N, window, features)."""
    n_samples = X.shape[0]
    indices = np.arange(0, n_samples - window + 1, stride)
    X_windows = np.empty((len(indices), window, X.shape[1]), dtype=np.float32)
    y_windows = np.empty(len(indices), dtype=np.int64)

    for i, start in enumerate(indices):
        X_windows[i] = X[start : start + window]
        y_windows[i] = y[start + window - 1]

    return X_windows, y_windows


# ═════════════════════════════════════════════════════════
#  Step 5 — Partition & save per client
# ═════════════════════════════════════════════════════════
def partition_and_save(
    df: pd.DataFrame,
    X_scaled: np.ndarray,
    y: np.ndarray,
    client_partition: dict[str, list[str]],
    window: int,
    stride: int,
    chunk_size: int,
) -> None:
    """Split by day, create windows, save .npy chunks per client."""
    day_col = df["_day"].values  # preserved from original merge

    print(f"\n{'='*60}")
    print(f" Partitioning → {len(client_partition)} clients")
    print(f"{'='*60}")

    for client_id, days in client_partition.items():
        print(f"\n  ── {client_id} (days: {days}) ──")

        # Select rows for this client's days
        mask = np.isin(day_col, days)
        X_client = X_scaled[mask]
        y_client = y[mask]

        if len(X_client) == 0:
            print(f"    ⚠  No data for days {days} — skipping")
            continue

        # Create sliding windows
        X_win, y_win = create_windows(X_client, y_client, window, stride)
        attack_ratio = y_win.mean() * 100

        print(f"    Raw rows      : {X_client.shape[0]:>10,}")
        print(f"    Windows       : {X_win.shape[0]:>10,}")
        print(f"    Window shape  : {X_win.shape}")
        print(f"    Attack ratio  : {attack_ratio:.2f}%")

        # Save in chunks (matching FL client's ClientSequenceDataset format)
        client_dir = CLIENT_DATA_DIR / client_id
        client_dir.mkdir(parents=True, exist_ok=True)

        # Remove old chunk files
        for old in client_dir.glob("*_seq_chunk_*.npy"):
            old.unlink()

        n_windows = X_win.shape[0]
        chunk_id = 0
        for start in range(0, n_windows, chunk_size):
            end = min(start + chunk_size, n_windows)
            x_chunk = X_win[start:end]
            y_chunk = y_win[start:end]

            np.save(str(client_dir / f"X_seq_chunk_{chunk_id}.npy"), x_chunk)
            np.save(str(client_dir / f"y_seq_chunk_{chunk_id}.npy"), y_chunk)
            chunk_id += 1

        print(f"    Saved chunks  : {chunk_id}  → {client_dir}")


# ═════════════════════════════════════════════════════════
#  Main
# ═════════════════════════════════════════════════════════
def main() -> None:
    parser = argparse.ArgumentParser(description="Preprocess CIC-IDS2017 for FL")
    parser.add_argument("--window", type=int, default=10,
                        help="Sliding window size (default: 10)")
    parser.add_argument("--stride", type=int, default=5,
                        help="Sliding window stride (default: 5)")
    parser.add_argument("--chunk-size", type=int, default=50_000,
                        help="Max samples per .npy chunk (default: 50000)")
    parser.add_argument("--clients", type=int, default=0,
                        help="Number of clients for IID split (0 = use day-based partition)")
    args = parser.parse_args()

    print("=" * 60)
    print(" CIC-IDS2017 Preprocessing")
    print("=" * 60)
    print(f"  Window size : {args.window}")
    print(f"  Stride      : {args.stride}")
    print(f"  Chunk size  : {args.chunk_size:,}")
    print()

    # ── 1. Load ──
    print("[1/5] Loading CSV files …")
    df = load_csvs()

    # ── 2. Clean ──
    print("\n[2/5] Cleaning data …")
    X_df, y_series = clean_data(df)
    y_arr = y_series.values

    # ── 3. Scale ──
    print("\n[3/5] Fitting StandardScaler …")
    X_scaled = fit_and_scale(X_df)

    # ── 4. Determine client partition ──
    if args.clients > 0:
        # IID random split across N clients
        print(f"\n[4/5] IID partition across {args.clients} clients …")
        n = len(X_scaled)
        indices = np.random.permutation(n)
        splits = np.array_split(indices, args.clients)
        client_partition = {}
        # For IID, we tag everything as one "day" and split by index
        df["_day"] = "all"
        # We'll handle IID differently: split the scaled data directly
        partition_iid(X_scaled, y_arr, splits, args.window, args.stride, args.chunk_size)
        print_summary()
        return
    else:
        print(f"\n[4/5] Day-based partition (3 clients) …")
        client_partition = DEFAULT_CLIENT_PARTITION

    # ── 5. Partition & save ──
    print("\n[5/5] Creating windows & saving per-client data …")
    partition_and_save(df, X_scaled, y_arr, client_partition,
                       args.window, args.stride, args.chunk_size)

    print_summary()


def partition_iid(
    X_scaled: np.ndarray,
    y: np.ndarray,
    splits: list[np.ndarray],
    window: int,
    stride: int,
    chunk_size: int,
) -> None:
    """IID random partition across N clients."""
    for i, indices in enumerate(splits):
        client_id = f"client_{i}"
        X_client = X_scaled[indices]
        y_client = y[indices]

        # Sort indices to preserve temporal order for windowing
        order = np.argsort(indices)
        X_client = X_client[order]
        y_client = y_client[order]

        X_win, y_win = create_windows(X_client, y_client, window, stride)
        attack_ratio = y_win.mean() * 100

        print(f"\n  ── {client_id} ──")
        print(f"    Raw rows      : {len(indices):>10,}")
        print(f"    Windows       : {X_win.shape[0]:>10,}")
        print(f"    Attack ratio  : {attack_ratio:.2f}%")

        client_dir = CLIENT_DATA_DIR / client_id
        client_dir.mkdir(parents=True, exist_ok=True)
        for old in client_dir.glob("*_seq_chunk_*.npy"):
            old.unlink()

        n_windows = X_win.shape[0]
        chunk_id = 0
        for start in range(0, n_windows, chunk_size):
            end = min(start + chunk_size, n_windows)
            np.save(str(client_dir / f"X_seq_chunk_{chunk_id}.npy"), X_win[start:end])
            np.save(str(client_dir / f"y_seq_chunk_{chunk_id}.npy"), y_win[start:end])
            chunk_id += 1

        print(f"    Saved chunks  : {chunk_id}  → {client_dir}")


def print_summary() -> None:
    """Print final summary of all client data directories."""
    print(f"\n{'='*60}")
    print(f" SUMMARY")
    print(f"{'='*60}")
    print(f"  Scaler   : {SCALER_OUT}")

    total_windows = 0
    for client_dir in sorted(CLIENT_DATA_DIR.iterdir()):
        if not client_dir.is_dir():
            continue
        x_files = sorted(client_dir.glob("X_seq_chunk_*.npy"))
        y_files = sorted(client_dir.glob("y_seq_chunk_*.npy"))
        if not x_files:
            continue

        n_windows = 0
        n_attacks = 0
        shape = None
        for xf, yf in zip(x_files, y_files):
            x = np.load(str(xf), mmap_mode="r")
            y = np.load(str(yf), mmap_mode="r")
            n_windows += len(y)
            n_attacks += int(y.sum())
            shape = x.shape[1:]  # (window, features)
        total_windows += n_windows
        atk_pct = (n_attacks / n_windows * 100) if n_windows else 0

        print(f"\n  {client_dir.name}:")
        print(f"    Chunks        : {len(x_files)}")
        print(f"    Total windows : {n_windows:,}")
        print(f"    Window shape  : {shape}")
        print(f"    Attack ratio  : {atk_pct:.2f}%")
        print(f"    Attack count  : {n_attacks:,}")
        print(f"    Benign count  : {n_windows - n_attacks:,}")

    print(f"\n  Total windows across all clients: {total_windows:,}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
