#!/usr/bin/env python3
"""
Per-attack-type evasion evaluation for the FYP thesis.

Loads the trained CNN_LSTM_IDS model and the CVAE decoder, generates synthetic
traffic samples for each of the 15 CIC-IDS2017 attack classes, and measures
what fraction are correctly flagged as attacks (detection rate).

This produces the core per-class comparison table for the thesis:
    Class            | Count | Detection Rate | Notes
    -----------------+-------+----------------+-------
    dos hulk         | 500   | 97.4%          | common — easy
    heartbleed       | 500   | 8.2%           | rare — model never saw enough
    ...

Usage:
    python scripts/test_evasion.py
    python scripts/test_evasion.py --samples 1000 --device cuda
    python scripts/test_evasion.py --output results/evasion_report.csv

Requirements:
    model/cvae_decoder.pt           (from Kaggle training)
    model/cvae_scaler.pkl           (from Kaggle training)
    model/global_final.pt  OR  model/cnn_lstm_global_with_HE_25rounds_16k.pt
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import joblib
import numpy as np
import torch
import torch.nn.functional as F

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from fl_common.cvae import CVAEDecoder, CLASS_NAMES, NUM_CLASSES  # noqa: E402
from fl_common.model import CNN_LSTM_IDS                           # noqa: E402

# ── paths ────────────────────────────────────────────────────────────────────
MODEL_DIR = PROJECT_ROOT / "model"
DECODER_PATH = MODEL_DIR / "cvae_decoder.pt"
CVAE_SCALER_PATH = MODEL_DIR / "cvae_scaler.pkl"
IDS_MODEL_CANDIDATES = [
    MODEL_DIR / "global_final.pt",
    MODEL_DIR / "cnn_lstm_global_with_HE_25rounds_16k.pt",
]

# Classes where binary label = attack (all except benign=0)
ATTACK_CLASSES = list(range(1, NUM_CLASSES))


def load_ids_model(device: torch.device) -> CNN_LSTM_IDS:
    """Load best available IDS model weights."""
    for path in IDS_MODEL_CANDIDATES:
        if path.exists():
            model = CNN_LSTM_IDS()
            state = torch.load(str(path), map_location=device)
            # Handle wrapped state dicts
            if isinstance(state, dict) and "model_state_dict" in state:
                state = state["model_state_dict"]
            model.load_state_dict(state)
            model.to(device)
            model.eval()
            print(f"IDS model loaded: {path.name}")
            return model
    print("ERROR: No IDS model found. Tried:")
    for p in IDS_MODEL_CANDIDATES:
        print(f"  {p}")
    sys.exit(1)


def load_decoder(device: torch.device) -> CVAEDecoder:
    """Load CVAE decoder."""
    if not DECODER_PATH.exists():
        print(f"ERROR: CVAE decoder not found at {DECODER_PATH}")
        print("Run the Kaggle training kernel first, then download artifacts.")
        sys.exit(1)
    decoder = CVAEDecoder()
    decoder.load_state_dict(torch.load(str(DECODER_PATH), map_location=device))
    decoder.to(device)
    decoder.eval()
    print(f"CVAE decoder loaded: {DECODER_PATH.name}")
    return decoder


def generate_samples(
    decoder: CVAEDecoder,
    class_id: int,
    n_samples: int,
    device: torch.device,
) -> torch.Tensor:
    """Generate `n_samples` synthetic windows for the given class_id."""
    with torch.no_grad():
        z = torch.randn(n_samples, 128, device=device)
        cond = F.one_hot(
            torch.full((n_samples,), class_id, dtype=torch.long, device=device),
            num_classes=NUM_CLASSES,
        ).float()
        return decoder(z, cond)  # (n_samples, 10, 78)


@torch.no_grad()
def detect(
    ids_model: CNN_LSTM_IDS,
    samples: torch.Tensor,
    threshold: float = 0.5,
    batch_size: int = 512,
) -> np.ndarray:
    """
    Run IDS model on samples, return binary predictions (0=benign, 1=attack).
    Processes in batches to avoid OOM on large sample sets.
    """
    preds = []
    for start in range(0, len(samples), batch_size):
        batch = samples[start : start + batch_size]
        logits = ids_model(batch)            # (B, 1)
        probs = torch.sigmoid(logits).squeeze(-1)
        preds.append((probs >= threshold).long().cpu().numpy())
    return np.concatenate(preds)


def run_evaluation(args: argparse.Namespace) -> None:
    device = torch.device(args.device if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}\n")

    ids_model = load_ids_model(device)
    decoder = load_decoder(device)

    results: list[dict] = []
    header = f"{'Class ID':>8}  {'Class Name':<30}  {'Detected':>8}  {'Total':>6}  {'Rate':>7}"
    print("\n" + header)
    print("-" * len(header))

    for class_id in range(NUM_CLASSES):
        class_name = CLASS_NAMES[class_id]
        is_attack = class_id != 0  # benign = 0

        samples = generate_samples(decoder, class_id, args.samples, device)
        preds = detect(ids_model, samples, threshold=args.threshold)

        if is_attack:
            # True positives: generated attack correctly classified as attack
            detected = int(preds.sum())
            rate = detected / args.samples
            tag = ""
        else:
            # True negatives: generated benign correctly classified as benign
            detected = int((preds == 0).sum())
            rate = detected / args.samples
            tag = "(benign → TN)"

        print(
            f"{class_id:>8}  {class_name:<30}  {detected:>8}  "
            f"{args.samples:>6}  {rate:>6.1%}  {tag}"
        )
        results.append({
            "class_id": class_id,
            "class_name": class_name,
            "is_attack": is_attack,
            "n_samples": args.samples,
            "detected": detected,
            "detection_rate": round(rate, 4),
        })

    # ── summary stats ────────────────────────────────────────────────────────
    attack_results = [r for r in results if r["is_attack"]]
    avg_detection = np.mean([r["detection_rate"] for r in attack_results])
    best = max(attack_results, key=lambda r: r["detection_rate"])
    worst = min(attack_results, key=lambda r: r["detection_rate"])

    print(f"\n{'='*60}")
    print(f" Attack Detection Summary")
    print(f"{'='*60}")
    print(f"  Average detection rate (attacks only): {avg_detection:.1%}")
    print(f"  Best : {best['class_name']:<30} {best['detection_rate']:.1%}")
    print(f"  Worst: {worst['class_name']:<30} {worst['detection_rate']:.1%}")

    # ── CSV output ────────────────────────────────────────────────────────────
    if args.output:
        import csv
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=results[0].keys())
            writer.writeheader()
            writer.writerows(results)
        print(f"\nResults saved to {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Per-attack CVAE evasion evaluation")
    parser.add_argument("--samples", type=int, default=500,
                        help="Synthetic samples per class (default: 500)")
    parser.add_argument("--threshold", type=float, default=0.5,
                        help="IDS detection threshold (default: 0.5)")
    parser.add_argument("--device", type=str, default="cpu",
                        help="Device: cuda or cpu (default: cpu)")
    parser.add_argument("--output", type=str, default=None,
                        help="Optional CSV output path")
    args = parser.parse_args()
    run_evaluation(args)


if __name__ == "__main__":
    main()
