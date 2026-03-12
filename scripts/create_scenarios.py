#!/usr/bin/env python3
"""
Scenario Creator — builds attack scenario packs from the CIC-IDS2017 dataset.

Each scenario is a curated subset of the full dataset, targeting specific
attack types or traffic patterns. Output:

    data/scenarios/<scenario_name>/
        X.npy          — (N, 10, 78)  float32  scaled windows
        y.npy          — (N,)         int64    labels
        metadata.json  — scenario description, stats, attack labels

This script uses the already-fitted StandardScaler from
  model/standard_scaler.pkl

Usage:
    python scripts/create_scenarios.py                  # all scenarios
    python scripts/create_scenarios.py --scenario ddos  # one scenario
    python scripts/create_scenarios.py --list           # list available
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

# ── paths ────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATASET_DIR = PROJECT_ROOT / "datasets" / "cicids2017"
SCENARIO_DIR = PROJECT_ROOT / "data" / "scenarios"
SCALER_PATH = PROJECT_ROOT / "model" / "standard_scaler.pkl"

# ── CSV file ↔ day mapping (same as preprocess script) ──
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

# 78 expected features (canonical order)
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

# ── Scenario definitions ────────────────────────────────
# Each scenario specifies which CIC-IDS2017 labels to include and
# what fraction of benign traffic to mix in for context.

SCENARIOS = {
    "ddos_attack": {
        "description": "DDoS attack traffic mixed with benign flows",
        "attack_labels": ["ddos"],
        "benign_ratio": 0.3,       # 30% benign, 70% attack
        "max_windows": 10000,
        "csv_filter": ["Friday-WorkingHours-Afternoon-DDos.pcap_ISCX.csv"],
    },
    "portscan": {
        "description": "Port scanning activity with normal background traffic",
        "attack_labels": ["portscan"],
        "benign_ratio": 0.4,
        "max_windows": 10000,
        "csv_filter": ["Friday-WorkingHours-Afternoon-PortScan.pcap_ISCX.csv"],
    },
    "brute_force": {
        "description": "SSH/FTP brute force attacks",
        "attack_labels": ["ftp patator", "ssh patator"],
        "benign_ratio": 0.3,
        "max_windows": 8000,
        "csv_filter": ["Tuesday-WorkingHours.pcap_ISCX.csv"],
    },
    "web_attacks": {
        "description": "Web-based attacks (XSS, SQL Injection, Brute Force)",
        "attack_labels": ["web attack", "xss", "sql injection", "brute force"],
        "benign_ratio": 0.3,
        "max_windows": 8000,
        "csv_filter": ["Thursday-WorkingHours-Morning-WebAttacks.pcap_ISCX.csv"],
    },
    "infiltration": {
        "description": "Network infiltration / lateral movement",
        "attack_labels": ["infiltration"],
        "benign_ratio": 0.3,
        "max_windows": 8000,
        "csv_filter": ["Thursday-WorkingHours-Afternoon-Infilteration.pcap_ISCX.csv"],
    },
    "botnet": {
        "description": "Botnet command & control traffic",
        "attack_labels": ["bot"],
        "benign_ratio": 0.3,
        "max_windows": 8000,
        "csv_filter": None,  # search all files
    },
    "benign_only": {
        "description": "Clean benign traffic — no attacks (baseline testing)",
        "attack_labels": [],    # empty = benign only
        "benign_ratio": 1.0,
        "max_windows": 10000,
        "csv_filter": ["Monday-WorkingHours.pcap_ISCX.csv"],
    },
    "mixed_traffic": {
        "description": "Realistic mixed traffic with multiple attack types (~30% attacks)",
        "attack_labels": ["all"],  # special: include ALL attack types
        "benign_ratio": 0.7,
        "max_windows": 15000,
        "csv_filter": None,   # all files
    },
    "high_intensity": {
        "description": "High attack intensity — stress test scenario (~80% attacks)",
        "attack_labels": ["all"],
        "benign_ratio": 0.2,
        "max_windows": 10000,
        "csv_filter": None,
    },
}


# ═════════════════════════════════════════════════════════
#  Data Loading & Cleaning (reuses preprocess logic)
# ═════════════════════════════════════════════════════════

def clean_label(label: str) -> str:
    """Normalise a CIC-IDS2017 label string."""
    label = str(label).strip().lower()
    label = re.sub(r"[^a-z0-9\s]", " ", label)
    label = re.sub(r"\s+", " ", label).strip()
    return label


def load_and_clean_csv(csv_files: list[str] | None = None) -> tuple[pd.DataFrame, pd.Series, pd.Series]:
    """
    Load specified CSV files (or all), clean features, return (X_df, y_binary, y_labels).

    y_binary: 0=benign, 1=attack
    y_labels: cleaned string labels (for filtering by attack type)
    """
    files_to_load = csv_files if csv_files else list(CSV_FILES.keys())

    frames = []
    for fname in files_to_load:
        path = DATASET_DIR / fname
        if not path.exists():
            print(f"  ⚠  Missing: {fname} — skipping")
            continue
        print(f"  Loading {fname} …", end=" ", flush=True)
        t0 = time.time()
        df = pd.read_csv(str(path), low_memory=False)
        df.columns = df.columns.str.strip()
        frames.append(df)
        print(f"{len(df):,} rows ({time.time() - t0:.1f}s)")

    if not frames:
        print("ERROR: No CSV files found")
        sys.exit(1)

    merged = pd.concat(frames, axis=0, ignore_index=True)

    # Extract labels
    y_labels = merged["Label"].apply(clean_label)
    y_binary = y_labels.apply(lambda x: 0 if x == "benign" else 1).astype(np.int64)

    # Clean features
    drop_cols = [c for c in ["Flow ID", "Source IP", "Destination IP",
                              "Source Port", "Timestamp", "Label"]
                 if c in merged.columns]
    X = merged.drop(columns=drop_cols)
    X = X.apply(pd.to_numeric, errors="coerce")
    X.replace([np.inf, -np.inf], np.nan, inplace=True)
    X.fillna(X.median(), inplace=True)
    X.fillna(0, inplace=True)

    # Remove constant columns
    constant_cols = [c for c in X.columns if X[c].nunique() <= 1]
    if constant_cols:
        X.drop(columns=constant_cols, inplace=True)

    # Ensure 78 features in canonical order
    available = set(X.columns)
    expected = set(EXPECTED_FEATURES)
    for col in expected - available:
        X[col] = 0.0
    extra = available - expected
    if extra:
        X.drop(columns=list(extra), inplace=True)
    X = X[EXPECTED_FEATURES].astype(np.float32)

    # Drop any remaining NaN rows
    mask = X.notna().all(axis=1)
    X = X[mask].reset_index(drop=True)
    y_binary = y_binary[mask].reset_index(drop=True)
    y_labels = y_labels[mask].reset_index(drop=True)

    print(f"  Cleaned: {len(X):,} rows × {X.shape[1]} features")
    return X, y_binary, y_labels


def create_windows(X: np.ndarray, y: np.ndarray, window: int = 10, stride: int = 1) -> tuple[np.ndarray, np.ndarray]:
    """Create sliding windows of shape (N, window, features)."""
    n = X.shape[0]
    indices = np.arange(0, n - window + 1, stride)
    X_win = np.empty((len(indices), window, X.shape[1]), dtype=np.float32)
    y_win = np.empty(len(indices), dtype=np.int64)
    for i, start in enumerate(indices):
        X_win[i] = X[start:start + window]
        y_win[i] = y[start + window - 1]
    return X_win, y_win


# ═════════════════════════════════════════════════════════
#  Scenario Builder
# ═════════════════════════════════════════════════════════

def build_scenario(name: str, config: dict) -> None:
    """Build a single scenario pack."""
    print(f"\n{'='*60}")
    print(f" Building scenario: {name}")
    print(f" {config['description']}")
    print(f"{'='*60}")

    # Load scaler
    if not SCALER_PATH.exists():
        print(f"ERROR: StandardScaler not found at {SCALER_PATH}")
        print("Run 'python scripts/preprocess_cicids2017.py' first.")
        sys.exit(1)

    scaler = joblib.load(str(SCALER_PATH))

    # Load CSV data
    csv_filter = config.get("csv_filter")
    X_df, y_binary, y_labels = load_and_clean_csv(csv_filter)

    # Filter by attack labels
    attack_labels = config["attack_labels"]
    benign_ratio = config["benign_ratio"]

    if not attack_labels:
        # Benign only
        mask = y_binary == 0
        X_selected = X_df[mask].values
        y_selected = y_binary[mask].values
        print(f"  Selected {len(X_selected):,} benign flows")
    elif "all" in attack_labels:
        # All attack types + benign mix
        attack_mask = y_binary == 1
        benign_mask = y_binary == 0

        n_attack = int(attack_mask.sum())
        n_benign_target = int(n_attack * benign_ratio / (1.0 - benign_ratio)) if benign_ratio < 1.0 else n_attack

        # Sample benign rows
        benign_indices = np.where(benign_mask.values)[0]
        if len(benign_indices) > n_benign_target:
            rng = np.random.default_rng(42)
            benign_indices = rng.choice(benign_indices, size=n_benign_target, replace=False)

        attack_indices = np.where(attack_mask.values)[0]
        all_indices = np.sort(np.concatenate([attack_indices, benign_indices]))

        X_selected = X_df.values[all_indices]
        y_selected = y_binary.values[all_indices]
        print(f"  Selected {len(attack_indices):,} attack + {len(benign_indices):,} benign = {len(X_selected):,}")
    else:
        # Specific attack types
        attack_mask = y_labels.apply(
            lambda lbl: any(atk in lbl for atk in attack_labels)
        )
        benign_mask = y_binary == 0

        n_attack = int(attack_mask.sum())
        if n_attack == 0:
            print(f"  ⚠  No flows found for labels {attack_labels} — skipping")
            return

        n_benign_target = int(n_attack * benign_ratio / max(1.0 - benign_ratio, 0.01))

        benign_indices = np.where(benign_mask.values)[0]
        if len(benign_indices) > n_benign_target:
            rng = np.random.default_rng(42)
            benign_indices = rng.choice(benign_indices, size=n_benign_target, replace=False)

        attack_indices = np.where(attack_mask.values)[0]
        all_indices = np.sort(np.concatenate([attack_indices, benign_indices]))

        X_selected = X_df.values[all_indices]
        y_selected = y_binary.values[all_indices]

        # Count unique attack labels found
        found_labels = y_labels.iloc[attack_indices].unique()
        print(f"  Attack labels found: {list(found_labels)}")
        print(f"  Selected {len(attack_indices):,} attack + {len(benign_indices):,} benign = {len(X_selected):,}")

    if len(X_selected) == 0:
        print("  ⚠  No data after filtering — skipping")
        return

    # Scale with the fitted StandardScaler
    X_scaled = scaler.transform(X_selected)
    X_scaled = np.nan_to_num(X_scaled, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)

    # Create sliding windows
    X_win, y_win = create_windows(X_scaled, y_selected, window=10, stride=3)

    # Cap at max_windows
    max_w = config.get("max_windows", 10000)
    if len(X_win) > max_w:
        rng = np.random.default_rng(42)
        idx = rng.choice(len(X_win), size=max_w, replace=False)
        idx.sort()
        X_win = X_win[idx]
        y_win = y_win[idx]
        print(f"  Capped to {max_w:,} windows (from {len(X_win):,})")

    # Save
    out_dir = SCENARIO_DIR / name
    out_dir.mkdir(parents=True, exist_ok=True)

    np.save(str(out_dir / "X.npy"), X_win)
    np.save(str(out_dir / "y.npy"), y_win)

    metadata = {
        "name": name,
        "description": config["description"],
        "attack_labels": attack_labels,
        "benign_ratio": benign_ratio,
        "total_windows": int(len(X_win)),
        "attack_count": int(y_win.sum()),
        "benign_count": int((y_win == 0).sum()),
        "attack_rate": round(float(y_win.mean()), 4),
        "window_shape": list(X_win.shape[1:]),
        "csv_files_used": csv_filter or list(CSV_FILES.keys()),
    }

    with open(str(out_dir / "metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\n  ✅ Saved to {out_dir}")
    print(f"     X.npy: {X_win.shape}")
    print(f"     y.npy: {y_win.shape}")
    print(f"     Attack rate: {metadata['attack_rate']:.1%}")


# ═════════════════════════════════════════════════════════
#  Main
# ═════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="Create CIC-IDS2017 scenario packs")
    parser.add_argument("--scenario", "-s", type=str, default=None,
                        help="Build a specific scenario (by name)")
    parser.add_argument("--list", "-l", action="store_true",
                        help="List all available scenarios and exit")
    args = parser.parse_args()

    if args.list:
        print("\nAvailable scenarios:")
        print("-" * 60)
        for name, cfg in SCENARIOS.items():
            labels = cfg["attack_labels"] or ["(benign only)"]
            print(f"  {name:20s}  {cfg['description']}")
            print(f"  {'':20s}  Attack labels: {labels}")
            print(f"  {'':20s}  Max windows: {cfg['max_windows']:,}")
            print()
        return

    if args.scenario:
        if args.scenario not in SCENARIOS:
            print(f"ERROR: Unknown scenario '{args.scenario}'")
            print(f"Available: {list(SCENARIOS.keys())}")
            sys.exit(1)
        build_scenario(args.scenario, SCENARIOS[args.scenario])
    else:
        print("=" * 60)
        print(" Building ALL scenarios")
        print("=" * 60)
        for name, cfg in SCENARIOS.items():
            build_scenario(name, cfg)

    print(f"\n{'='*60}")
    print(" All scenarios built successfully!")
    print(f" Output: {SCENARIO_DIR}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
