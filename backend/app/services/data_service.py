"""
Client training data service — auto-generates training data for new FL clients.

Strategy: Copies a random 30% subset of .npy chunks from any existing client
that already has data (CIC-IDS2017 preprocessed format).  For synthetic data,
generates random sequences with realistic class imbalance.

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
import shutil
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

# Inside the Docker container, client data is mounted here
CLIENT_DATA_ROOT = "/app/client_data"

# CIC-IDS2017 data dimensions
SEQ_LEN = 10
NUM_FEATURES = 78

# What fraction of source chunks to copy (30%)
SUBSET_FRACTION = 0.30

# Minimum rows to keep per chunk subset (avoid tiny files)
MIN_ROWS_PER_CHUNK = 500

# Synthetic chunk size and number of chunks when generating fake data
SYNTHETIC_CHUNK_ROWS = 2000
SYNTHETIC_NUM_CHUNKS = 3


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


def _generate_synthetic_data(target_dir: str) -> dict:
    """Create random synthetic traffic data in CIC-IDS2017 format."""
    os.makedirs(target_dir, exist_ok=True)
    total_samples = 0

    for i in range(SYNTHETIC_NUM_CHUNKS):
        n = SYNTHETIC_CHUNK_ROWS
        # Random feature values (normalised to [0, 1])
        x = np.random.rand(n, SEQ_LEN, NUM_FEATURES).astype(np.float32)
        # Realistic class imbalance: ~80% benign (0), ~20% attack (1)
        y = (np.random.rand(n) < 0.2).astype(np.int64)
        np.save(os.path.join(target_dir, f"X_seq_chunk_{i}.npy"), x)
        np.save(os.path.join(target_dir, f"y_seq_chunk_{i}.npy"), y)
        total_samples += n

    log.info("Generated %d synthetic chunks (%d samples) in %s",
             SYNTHETIC_NUM_CHUNKS, total_samples, target_dir)
    return {
        "created": True,
        "source": "synthetic",
        "chunks": SYNTHETIC_NUM_CHUNKS,
        "total_samples": total_samples,
        "path": target_dir,
    }


def generate_client_data(client_id: str, data_source: str = "cic-ids2017") -> dict:
    """
    Generate training data for a new client.

    data_source: 'cic-ids2017' — copy a random 30% subset from an existing client
                 'synthetic'   — generate random sequences with realistic class imbalance

    Returns dict with: created, source, chunks, total_samples, path.
    """
    target_dir = os.path.join(CLIENT_DATA_ROOT, client_id.lower())

    # Don't overwrite if data already exists
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
        return _generate_synthetic_data(target_dir)

    # CIC-IDS2017: copy subset from any available source client
    source_id = _get_source_client(exclude=client_id)
    if source_id is None:
        log.warning("No CIC-IDS2017 source data found — falling back to synthetic")
        return _generate_synthetic_data(target_dir)

    source_dir = os.path.join(CLIENT_DATA_ROOT, source_id)
    x_files = sorted([f for f in os.listdir(source_dir) if f.startswith("X_seq") and f.endswith(".npy")])
    y_files = sorted([f for f in os.listdir(source_dir) if f.startswith("y_seq") and f.endswith(".npy")])

    if not x_files or len(x_files) != len(y_files):
        log.error("Source client %s has mismatched data files — falling back to synthetic", source_id)
        return _generate_synthetic_data(target_dir)

    os.makedirs(target_dir, exist_ok=True)
    total_samples = 0
    chunks_created = 0

    for i, (xf, yf) in enumerate(zip(x_files, y_files)):
        try:
            x_src = np.load(os.path.join(source_dir, xf))
            y_src = np.load(os.path.join(source_dir, yf))

            n = len(x_src)
            subset_size = max(MIN_ROWS_PER_CHUNK, int(n * SUBSET_FRACTION))
            subset_size = min(subset_size, n)

            indices = np.random.choice(n, size=subset_size, replace=False)
            indices.sort()

            np.save(os.path.join(target_dir, f"X_seq_chunk_{i}.npy"), x_src[indices])
            np.save(os.path.join(target_dir, f"y_seq_chunk_{i}.npy"), y_src[indices])

            total_samples += subset_size
            chunks_created += 1
            log.info("  Chunk %d: %d/%d rows from %s/%s", i, subset_size, n, source_id, xf)

        except Exception as exc:
            log.error("Failed to process chunk %d from %s: %s", i, source_id, exc)

    log.info("Generated CIC-IDS2017 data for client %s: %d chunks, %d samples (from %s)",
             client_id, chunks_created, total_samples, source_id)
    return {
        "created": True,
        "source": source_id,
        "chunks": chunks_created,
        "total_samples": total_samples,
        "path": target_dir,
    }


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
