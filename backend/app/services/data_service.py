"""
Client training data service — generates training data for FL clients.

Supports two data sources:
  - CIC-IDS2017: Reads real CSV network traffic data, cleans, scales, creates
    sliding windows. Respects traffic_type (benign=only BENIGN rows, mixed=all).
  - Synthetic: Generates CVAE-based realistic traffic sequences when
    model/cvae_decoder.pt is available, or falls back to random noise.

Data layout:
    /app/client_data/<client_id>/
        X_seq_chunk_0.npy   (N, 10, 78)
        y_seq_chunk_0.npy   (N,)
        ...

The backend container mounts `data/clients` → `/app/client_data` read-write,
while client Docker containers mount their own subdir at `/app/data` read-only.
"""

from __future__ import annotations

import logging
import os
import random
import re
import shutil
from typing import Optional

import joblib
import numpy as np

log = logging.getLogger(__name__)

# Inside the Docker container, client data is mounted here
CLIENT_DATA_ROOT = "/app/client_data"
DATASET_DIR = "/app/datasets/cicids2017"
SCALER_PATH = "/app/models/standard_scaler.pkl"

# CVAE artifacts (produced by Kaggle training, mounted via ./model:/app/models)
CVAE_DECODER_PATH = "/app/models/cvae_decoder.pt"
CVAE_SCALER_PATH = "/app/models/cvae_scaler.pkl"

# CIC-IDS2017 data dimensions
SEQ_LEN = 10
NUM_FEATURES = 78

# Synthetic chunk size and number of chunks when generating fake data
SYNTHETIC_CHUNK_ROWS = 5000
SYNTHETIC_NUM_CHUNKS = 3

# Max rows to sample from CIC-IDS2017 per client (keeps generation < 30s)
MAX_CICIDS_ROWS = 50000

# Canonical 78-feature list for CIC-IDS2017
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


def _clean_label(label: str) -> str:
    label = str(label).strip().lower()
    label = re.sub(r"[^a-z0-9\s]", " ", label)
    return re.sub(r"\s+", " ", label).strip()


def _generate_from_cicids2017(
    target_dir: str,
    traffic_type: str = "mixed",
    client_id: str = "",
) -> dict:
    """
    Process real CIC-IDS2017 CSV files into training-ready .npy chunks.
    
    traffic_type: 'benign' — only BENIGN rows, 'mixed' — all rows (benign + attack).
    """
    import pandas as pd

    csv_files = sorted([
        os.path.join(DATASET_DIR, f)
        for f in os.listdir(DATASET_DIR) if f.endswith(".csv")
    ]) if os.path.isdir(DATASET_DIR) else []

    if not csv_files:
        log.warning("No CIC-IDS2017 CSVs found in %s — falling back to copy method", DATASET_DIR)
        return _copy_from_existing(target_dir, client_id)

    log.info("Processing CIC-IDS2017 CSVs for client %s (traffic_type=%s)", client_id, traffic_type)

    # Load and concatenate all CSVs
    frames = []
    for csv_path in csv_files:
        try:
            df = pd.read_csv(csv_path, encoding="utf-8", low_memory=False)
            df.columns = df.columns.str.strip()
            frames.append(df)
            log.info("  Loaded %s: %d rows", os.path.basename(csv_path), len(df))
        except Exception as exc:
            log.warning("  Failed to load %s: %s", csv_path, exc)

    if not frames:
        log.warning("No CSV data loaded — falling back to copy method")
        return _copy_from_existing(target_dir, client_id)

    df = pd.concat(frames, ignore_index=True)
    log.info("  Total rows loaded: %d", len(df))

    # Extract labels
    if "Label" not in df.columns:
        log.error("No 'Label' column in CSV data")
        return _generate_synthetic_data(target_dir, traffic_type)

    y_raw = df["Label"].apply(_clean_label)
    y = y_raw.apply(lambda x: 0 if x == "benign" else 1).astype(np.int64)

    # Filter by traffic type
    if traffic_type == "benign":
        mask = y == 0
        df = df[mask].reset_index(drop=True)
        y = y[mask].reset_index(drop=True)
        log.info("  Filtered to benign only: %d rows", len(df))
    else:
        log.info("  Using mixed traffic: %d benign + %d attack", (y == 0).sum(), (y == 1).sum())

    # Subsample if too large
    if len(df) > MAX_CICIDS_ROWS:
        indices = np.random.choice(len(df), MAX_CICIDS_ROWS, replace=False)
        indices.sort()
        df = df.iloc[indices].reset_index(drop=True)
        y = y.iloc[indices].reset_index(drop=True)
        log.info("  Subsampled to %d rows", len(df))

    # Drop non-feature columns
    drop_cols = [c for c in ["Flow ID", "Source IP", "Destination IP",
                              "Source Port", "Timestamp", "Label", "_day"]
                 if c in df.columns]
    X = df.drop(columns=drop_cols)
    X = X.apply(pd.to_numeric, errors="coerce")
    X.replace([np.inf, -np.inf], np.nan, inplace=True)
    X.fillna(X.median(), inplace=True)
    X.fillna(0, inplace=True)

    # Drop constant columns
    constant_cols = [c for c in X.columns if X[c].nunique() <= 1]
    if constant_cols:
        X.drop(columns=constant_cols, inplace=True)

    # Ensure 78 features in canonical order
    available = set(X.columns)
    expected = set(EXPECTED_FEATURES)
    for col in expected - available:
        X[col] = 0.0
    X = X[[c for c in EXPECTED_FEATURES if c in X.columns or True]]
    # Reorder to exact canonical order
    for col in EXPECTED_FEATURES:
        if col not in X.columns:
            X[col] = 0.0
    X = X[EXPECTED_FEATURES].astype(np.float32)

    # Scale using pre-fitted scaler
    X_arr = X.values
    if os.path.exists(SCALER_PATH):
        try:
            scaler = joblib.load(SCALER_PATH)
            X_arr = scaler.transform(X_arr).astype(np.float32)
            log.info("  Applied pre-fitted scaler from %s", SCALER_PATH)
        except Exception as exc:
            log.warning("  Failed to load scaler: %s — using unscaled data", exc)

    y_arr = y.values

    # Create sliding windows
    n_windows = len(X_arr) - SEQ_LEN + 1
    if n_windows <= 0:
        log.error("Not enough rows (%d) for sliding window (need %d)", len(X_arr), SEQ_LEN)
        return _generate_synthetic_data(target_dir, traffic_type)

    X_win = np.lib.stride_tricks.sliding_window_view(X_arr, (SEQ_LEN, NUM_FEATURES))
    X_win = X_win.squeeze(axis=1)  # (n_windows, SEQ_LEN, NUM_FEATURES)
    y_win = y_arr[SEQ_LEN - 1:]   # label = last element in window

    log.info("  Created %d sliding windows of shape (%d, %d)", len(X_win), SEQ_LEN, NUM_FEATURES)

    # Split into chunks and save
    os.makedirs(target_dir, exist_ok=True)
    chunk_size = max(5000, len(X_win) // 3)
    total_samples = 0
    chunks_created = 0

    for i in range(0, len(X_win), chunk_size):
        x_chunk = X_win[i:i + chunk_size]
        y_chunk = y_win[i:i + chunk_size]
        np.save(os.path.join(target_dir, f"X_seq_chunk_{chunks_created}.npy"), x_chunk)
        np.save(os.path.join(target_dir, f"y_seq_chunk_{chunks_created}.npy"), y_chunk)
        total_samples += len(x_chunk)
        chunks_created += 1

    attack_pct = (y_win.sum() / len(y_win) * 100) if len(y_win) > 0 else 0
    log.info(
        "Generated CIC-IDS2017 data for %s: %d chunks, %d windows, %.1f%% attack",
        client_id, chunks_created, total_samples, attack_pct,
    )
    return {
        "created": True,
        "source": "cicids2017",
        "data_quality": "real",
        "chunks": chunks_created,
        "total_samples": total_samples,
        "path": target_dir,
    }


def _copy_from_existing(target_dir: str, exclude: str = "") -> dict:
    """Fallback: copy 30% subset from any existing client that has .npy data."""
    available = [c for c in _find_source_clients() if c.lower() != exclude.lower()]
    if not available:
        return _generate_synthetic_data(target_dir)

    source_id = random.choice(available)
    source_dir = os.path.join(CLIENT_DATA_ROOT, source_id)
    x_files = sorted([f for f in os.listdir(source_dir) if f.startswith("X_seq") and f.endswith(".npy")])
    y_files = sorted([f for f in os.listdir(source_dir) if f.startswith("y_seq") and f.endswith(".npy")])

    if not x_files or len(x_files) != len(y_files):
        return _generate_synthetic_data(target_dir)

    os.makedirs(target_dir, exist_ok=True)
    total_samples = 0
    chunks_created = 0

    for i, (xf, yf) in enumerate(zip(x_files, y_files)):
        try:
            x_src = np.load(os.path.join(source_dir, xf))
            y_src = np.load(os.path.join(source_dir, yf))
            n = len(x_src)
            subset_size = max(500, int(n * 0.30))
            indices = np.random.choice(n, size=min(subset_size, n), replace=False)
            indices.sort()
            np.save(os.path.join(target_dir, f"X_seq_chunk_{i}.npy"), x_src[indices])
            np.save(os.path.join(target_dir, f"y_seq_chunk_{i}.npy"), y_src[indices])
            total_samples += len(indices)
            chunks_created += 1
        except Exception as exc:
            log.error("Failed to copy chunk %d from %s: %s", i, source_id, exc)

    return {
        "created": True,
        "source": source_id,
        "data_quality": "copied",
        "chunks": chunks_created,
        "total_samples": total_samples,
        "path": target_dir,
    }


def _find_source_clients() -> list[str]:
    """Return all client subdirs that have at least one X_seq*.npy file."""
    if not os.path.isdir(CLIENT_DATA_ROOT):
        return []
    sources = []
    for name in os.listdir(CLIENT_DATA_ROOT):
        d = os.path.join(CLIENT_DATA_ROOT, name)
        if os.path.isdir(d):
            x_files = [f for f in os.listdir(d) if f.startswith("X_seq") and f.endswith(".npy")]
            if x_files:
                sources.append(name)
    return sources


def _get_source_client(exclude: str = "") -> Optional[str]:
    """Pick a random source client that has data, excluding `exclude`."""
    available = [c for c in _find_source_clients() if c.lower() != exclude.lower()]
    return random.choice(available) if available else None


def _generate_synthetic_data(target_dir: str, traffic_type: str = "mixed") -> dict:
    """Generate synthetic traffic data in CIC-IDS2017 format.

    Strategy (in priority order):
      1. CVAE-based generation — uses trained decoder (cvae_decoder.pt) to
         produce statistically realistic traffic sequences conditioned on
         attack class.  Requires cvae_decoder.pt and cvae_scaler.pkl to be
         present in /app/models/.
      2. Random noise fallback — uniform np.random.rand().  Only used when
         CVAE artifacts are absent (e.g. before Kaggle training completes).
    """
    if os.path.exists(CVAE_DECODER_PATH) and os.path.exists(CVAE_SCALER_PATH):
        return _generate_cvae_data(target_dir, traffic_type)
    return _generate_random_fallback(target_dir, traffic_type)


def _generate_cvae_data(target_dir: str, traffic_type: str = "mixed") -> dict:
    """Generate realistic synthetic traffic using the trained CVAE decoder."""
    try:
        import torch
        import torch.nn.functional as F
        from fl_common.cvae import CVAEDecoder, NUM_CLASSES
    except ImportError as exc:
        log.warning("CVAE import failed (%s) — falling back to random noise", exc)
        return _generate_random_fallback(target_dir, traffic_type)

    log.info("CVAE synthesis — loading decoder from %s", CVAE_DECODER_PATH)

    try:
        decoder = CVAEDecoder()
        state = torch.load(CVAE_DECODER_PATH, map_location="cpu")
        decoder.load_state_dict(state)
        decoder.eval()

        scaler = joblib.load(CVAE_SCALER_PATH)
    except Exception as exc:
        log.warning("Failed to load CVAE artifacts (%s) — falling back to random noise", exc)
        return _generate_random_fallback(target_dir, traffic_type)

    # Class IDs to sample: 0=benign, 1-14=attacks
    # benign-only mode uses only class 0; mixed uses all 15 classes (weighted)
    if traffic_type == "benign":
        class_ids = [0]
        class_weights = [1.0]
    else:
        # Approx 70% benign, 30% spread across attack classes — mimics real traffic
        class_ids = list(range(NUM_CLASSES))
        class_weights = [70.0] + [2.0] * 14  # benign heavy, attacks equal

    os.makedirs(target_dir, exist_ok=True)
    total_samples = 0

    with torch.no_grad():
        for chunk_idx in range(SYNTHETIC_NUM_CHUNKS):
            n = SYNTHETIC_CHUNK_ROWS

            # Sample class IDs proportionally
            probs = np.array(class_weights, dtype=np.float64)
            probs /= probs.sum()
            sampled_classes = np.random.choice(class_ids, size=n, p=probs)

            # Batch generate by class to avoid per-sample forward passes
            x_chunks: list[np.ndarray] = []
            y_chunks: list[np.ndarray] = []

            for cls in np.unique(sampled_classes):
                mask = sampled_classes == cls
                count = int(mask.sum())

                z = torch.randn(count, 128)
                cond = F.one_hot(
                    torch.full((count,), int(cls), dtype=torch.long),
                    num_classes=NUM_CLASSES,
                ).float()
                generated = decoder(z, cond).numpy()  # (count, 10, 78)

                # Inverse-scale to approximate real-valued features
                # (reshape to 2D for scaler, then back to windows)
                flat = generated.reshape(-1, NUM_FEATURES)
                flat = scaler.inverse_transform(flat).astype(np.float32)
                # Re-scale with standard_scaler.pkl if available (FL pipeline expects it)
                if os.path.exists(SCALER_PATH):
                    try:
                        fl_scaler = joblib.load(SCALER_PATH)
                        flat = fl_scaler.transform(flat).astype(np.float32)
                    except Exception as e:
                        log.warning("standard_scaler transform failed: %s", e)
                generated = flat.reshape(count, SEQ_LEN, NUM_FEATURES)

                x_chunks.append(generated)
                # Binary label: 0 = benign, 1 = attack
                binary_label = 0 if cls == 0 else 1
                y_chunks.append(np.full(count, binary_label, dtype=np.int64))

            x_all = np.concatenate(x_chunks, axis=0)
            y_all = np.concatenate(y_chunks, axis=0)

            # Shuffle to mix classes within chunk
            perm = np.random.permutation(len(x_all))
            np.save(os.path.join(target_dir, f"X_seq_chunk_{chunk_idx}.npy"), x_all[perm])
            np.save(os.path.join(target_dir, f"y_seq_chunk_{chunk_idx}.npy"), y_all[perm])
            total_samples += len(x_all)

    attack_pct = 0.0 if traffic_type == "benign" else 30.0
    log.info(
        "CVAE generated %d chunks (%d samples, type=%s, ~%.0f%% attack) in %s",
        SYNTHETIC_NUM_CHUNKS, total_samples, traffic_type, attack_pct, target_dir,
    )
    return {
        "created": True,
        "source": "synthetic",
        "data_quality": "synthetic_cvae",
        "chunks": SYNTHETIC_NUM_CHUNKS,
        "total_samples": total_samples,
        "path": target_dir,
    }


def _generate_random_fallback(target_dir: str, traffic_type: str = "mixed") -> dict:
    """Last-resort fallback: uniform-random noise (np.random.rand).

    WARNING: This data is NOT realistic network traffic. The model cannot
    learn meaningful patterns from it. Use CIC-IDS2017 or CVAE data instead.
    """
    log.warning(
        "RANDOM NOISE FALLBACK — generating uniform-random data in %s. "
        "This data is NOT usable for real training. Ensure CIC-IDS2017 "
        "CSVs are mounted at %s or that CVAE artifacts are in /app/models/.",
        target_dir, DATASET_DIR,
    )
    os.makedirs(target_dir, exist_ok=True)
    total_samples = 0

    for i in range(SYNTHETIC_NUM_CHUNKS):
        n = SYNTHETIC_CHUNK_ROWS
        x = np.random.rand(n, SEQ_LEN, NUM_FEATURES).astype(np.float32)
        if traffic_type == "benign":
            y = np.zeros(n, dtype=np.int64)
        else:
            y = (np.random.rand(n) < 0.2).astype(np.int64)
        np.save(os.path.join(target_dir, f"X_seq_chunk_{i}.npy"), x)
        np.save(os.path.join(target_dir, f"y_seq_chunk_{i}.npy"), y)
        total_samples += n

    log.info("Generated %d random noise chunks (%d samples, type=%s) in %s",
             SYNTHETIC_NUM_CHUNKS, total_samples, traffic_type, target_dir)
    return {
        "created": True,
        "source": "synthetic",
        "data_quality": "synthetic_random",
        "chunks": SYNTHETIC_NUM_CHUNKS,
        "total_samples": total_samples,
        "path": target_dir,
        "warning": (
            "Data is random noise (np.random.rand). Model cannot learn "
            "meaningful patterns. Use CIC-IDS2017 data source for real training."
        ),
    }


def generate_client_data(
    client_id: str,
    data_source: str = "cic-ids2017",
    traffic_type: str = "mixed",
    force: bool = False,
) -> dict:
    """
    Generate training data for an FL client.

    data_source: 'cic-ids2017' — process real CSV network traffic data
                 'synthetic'   — generate random sequences
    traffic_type: 'benign' — benign traffic only, 'mixed' — benign + attack
    force: if True, regenerate even if data already exists.

    Returns dict with: created, source, chunks, total_samples, path.
    """
    target_dir = os.path.join(CLIENT_DATA_ROOT, client_id.lower())


    if os.path.islink(target_dir) and not os.path.exists(target_dir):
        os.unlink(target_dir)
        log.info("Removed dangling symlink for client %s: %s", client_id, target_dir)

    # Delete existing data if force regeneration requested
    if force and os.path.isdir(target_dir):
        shutil.rmtree(target_dir)
        log.info("Force-cleared existing data for client %s", client_id)

    # Don't overwrite if data already exists (unless forced)
    if os.path.isdir(target_dir):
        existing = [f for f in os.listdir(target_dir) if f.endswith(".npy")]
        if existing:
            log.info("Client %s already has %d data files — skipping generation",
                     client_id, len(existing))
            return {
                "created": False,
                "source": "existing",
                "chunks": len(existing) // 2,
                "total_samples": 0,
                "path": target_dir,
            }

    if data_source == "synthetic":
        return _generate_synthetic_data(target_dir, traffic_type)

    # CIC-IDS2017: process real CSV data with traffic type filtering
    return _generate_from_cicids2017(target_dir, traffic_type, client_id)


def delete_client_data(client_id: str) -> bool:
    """
    Remove the training data directory for a client.

    Safety: only deletes from CLIENT_DATA_ROOT subdirectory.
    """
    target_dir = os.path.join(CLIENT_DATA_ROOT, client_id.lower())
    if not os.path.isdir(target_dir):
        log.info("No data directory to delete for client %s", client_id)
        return True

    try:
        shutil.rmtree(target_dir)
        log.info("Deleted data directory for client %s: %s", client_id, target_dir)
        return True
    except Exception as exc:
        log.error("Failed to delete data for client %s: %s", client_id, exc)
        return False


def get_client_data_info(client_id: str) -> dict:
    """Get info about a client's training data."""
    data_dir = os.path.join(CLIENT_DATA_ROOT, client_id.lower())
    if not os.path.isdir(data_dir):
        return {"exists": False, "chunks": 0, "total_samples": 0, "path": data_dir}

    x_files = sorted([f for f in os.listdir(data_dir) if f.startswith("X_seq") and f.endswith(".npy")])
    total_samples = 0
    for xf in x_files:
        try:
            x = np.load(os.path.join(data_dir, xf), mmap_mode="r")
            total_samples += len(x)
        except Exception:
            pass

    return {
        "exists": True,
        "chunks": len(x_files),
        "total_samples": total_samples,
        "path": data_dir,
    }
