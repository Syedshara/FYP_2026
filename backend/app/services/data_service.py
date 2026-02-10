"""
Client training data service — auto-generates training data for new FL clients.

Strategy (Option B): Copies a random 30% subset of .npy chunks from an existing
client (bank_a, bank_b, or bank_c) into the new client's data directory.

This gives the new client realistic CIC-IDS2017 data with genuine attack patterns,
but a different subset from the source — suitable for non-IID federated learning.

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
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

# Inside the Docker container, client data is mounted here
CLIENT_DATA_ROOT = "/app/client_data"

# Source clients that always have real preprocessed data
SOURCE_CLIENTS = ["bank_a", "bank_b", "bank_c"]

# What fraction of source chunks to copy (30%)
SUBSET_FRACTION = 0.30

# Minimum rows to keep per chunk subset (avoid tiny files)
MIN_ROWS_PER_CHUNK = 500


def _get_source_client() -> Optional[str]:
    """Pick a random source client that has data."""
    available = []
    for cid in SOURCE_CLIENTS:
        d = os.path.join(CLIENT_DATA_ROOT, cid)
        if os.path.isdir(d):
            x_files = [f for f in os.listdir(d) if f.startswith("X_seq") and f.endswith(".npy")]
            if x_files:
                available.append(cid)
    if not available:
        return None
    return random.choice(available)


def generate_client_data(client_id: str) -> dict:
    """
    Generate training data for a new client by copying a random subset
    from an existing source client.

    Returns dict with:
        created: bool — whether data was created
        source: str — source client id
        chunks: int — number of chunk files created
        total_samples: int — total number of training samples
        path: str — data directory path
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

    # Find a source client
    source_id = _get_source_client()
    if source_id is None:
        log.error("No source client data available for subsetting")
        return {
            "created": False,
            "source": "none",
            "chunks": 0,
            "total_samples": 0,
            "path": target_dir,
        }

    source_dir = os.path.join(CLIENT_DATA_ROOT, source_id)
    x_files = sorted([f for f in os.listdir(source_dir) if f.startswith("X_seq") and f.endswith(".npy")])
    y_files = sorted([f for f in os.listdir(source_dir) if f.startswith("y_seq") and f.endswith(".npy")])

    if not x_files or len(x_files) != len(y_files):
        log.error("Source client %s has mismatched data files", source_id)
        return {"created": False, "source": source_id, "chunks": 0, "total_samples": 0, "path": target_dir}

    # Create target directory
    os.makedirs(target_dir, exist_ok=True)

    # Strategy: for each chunk in source, take a random 30% of rows
    total_samples = 0
    chunks_created = 0

    for i, (xf, yf) in enumerate(zip(x_files, y_files)):
        try:
            x_src = np.load(os.path.join(source_dir, xf))
            y_src = np.load(os.path.join(source_dir, yf))

            n = len(x_src)
            subset_size = max(MIN_ROWS_PER_CHUNK, int(n * SUBSET_FRACTION))
            subset_size = min(subset_size, n)  # Don't exceed source size

            # Random row indices (without replacement)
            indices = np.random.choice(n, size=subset_size, replace=False)
            indices.sort()  # Keep temporal order

            x_subset = x_src[indices]
            y_subset = y_src[indices]

            # Save to target
            np.save(os.path.join(target_dir, f"X_seq_chunk_{i}.npy"), x_subset)
            np.save(os.path.join(target_dir, f"y_seq_chunk_{i}.npy"), y_subset)

            total_samples += subset_size
            chunks_created += 1

            log.info("  Chunk %d: %d/%d rows from %s/%s", i, subset_size, n, source_id, xf)

        except Exception as exc:
            log.error("Failed to process chunk %d from %s: %s", i, source_id, exc)

    log.info("Generated data for client %s: %d chunks, %d samples (from %s)",
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

    Safety: Only deletes from CLIENT_DATA_ROOT, refuses to delete source clients.
    """
    # Safety check — never delete source client data
    if client_id.lower() in SOURCE_CLIENTS:
        log.warning("Refusing to delete source client data: %s", client_id)
        return False

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
