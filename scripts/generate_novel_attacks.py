#!/usr/bin/env python3
"""
Novel attack generation via latent space interpolation.

Demonstrates a key FYP capability: generating *unseen* attack variants by
interpolating or perturbing class centroids in the CVAE latent space.

Three experiments:
  1. Class interpolation   — smoothly blend two attack types (e.g., DoS Hulk → DDoS)
  2. Centroid perturbation — perturb known attack centroid with Gaussian noise
  3. Cross-class mixing    — mix centroids of multiple classes to create hybrids

All generated samples are scored by the IDS model to show detection rates.
This demonstrates that adversarially-crafted variants can evade detection.

Usage:
    python scripts/generate_novel_attacks.py
    python scripts/generate_novel_attacks.py --class-a 1 --class-b 6 --steps 10

Requirements:
    model/cvae_decoder.pt
    model/cvae_class_centroids.pkl
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

MODEL_DIR = PROJECT_ROOT / "model"
DECODER_PATH = MODEL_DIR / "cvae_decoder.pt"
CENTROIDS_PATH = MODEL_DIR / "cvae_class_centroids.pkl"
IDS_MODEL_CANDIDATES = [
    MODEL_DIR / "global_final.pt",
    MODEL_DIR / "cnn_lstm_global_with_HE_25rounds_16k.pt",
]


def _load_ids_model(device: torch.device) -> CNN_LSTM_IDS:
    for path in IDS_MODEL_CANDIDATES:
        if path.exists():
            model = CNN_LSTM_IDS()
            state = torch.load(str(path), map_location=device)
            if isinstance(state, dict) and "model_state_dict" in state:
                state = state["model_state_dict"]
            model.load_state_dict(state)
            model.to(device).eval()
            print(f"IDS model: {path.name}")
            return model
    print("ERROR: No IDS model found.")
    sys.exit(1)


def _load_decoder(device: torch.device) -> CVAEDecoder:
    if not DECODER_PATH.exists():
        print(f"ERROR: {DECODER_PATH} not found. Run Kaggle training first.")
        sys.exit(1)
    decoder = CVAEDecoder()
    decoder.load_state_dict(torch.load(str(DECODER_PATH), map_location=device))
    return decoder.to(device).eval()


def _load_centroids() -> dict[int, np.ndarray]:
    if not CENTROIDS_PATH.exists():
        print(f"ERROR: {CENTROIDS_PATH} not found. Run Kaggle training first.")
        sys.exit(1)
    return joblib.load(str(CENTROIDS_PATH))


@torch.no_grad()
def _decode_and_detect(
    decoder: CVAEDecoder,
    ids_model: CNN_LSTM_IDS,
    z: torch.Tensor,
    cond_class_id: int,
    device: torch.device,
    threshold: float = 0.5,
) -> tuple[torch.Tensor, float]:
    """Decode z with class condition and return (samples, detection_rate)."""
    cond = F.one_hot(
        torch.full((len(z),), cond_class_id, dtype=torch.long, device=device),
        num_classes=NUM_CLASSES,
    ).float()
    samples = decoder(z, cond)
    logits = ids_model(samples)
    probs = torch.sigmoid(logits).squeeze(-1)
    detection_rate = float((probs >= threshold).float().mean())
    return samples, detection_rate


# ══════════════════════════════════════════════════════════════════════════════
#  Experiment 1: Class interpolation
# ══════════════════════════════════════════════════════════════════════════════

def experiment_interpolation(
    decoder: CVAEDecoder,
    ids_model: CNN_LSTM_IDS,
    centroids: dict[int, np.ndarray],
    class_a: int,
    class_b: int,
    steps: int,
    n_samples: int,
    device: torch.device,
) -> None:
    """
    Interpolate latent centroids from class_a to class_b in `steps` steps.
    Use class_a as the condition throughout (simulating a stealthy class_a variant).
    """
    print(f"\n[Experiment 1] Interpolation: {CLASS_NAMES[class_a]} → {CLASS_NAMES[class_b]}")
    print(f"{'Alpha':>6}  {'Detection Rate':>15}  {'Description'}")
    print("-" * 50)

    mu_a = torch.tensor(centroids[class_a], device=device)
    mu_b = torch.tensor(centroids[class_b], device=device)

    for step in range(steps + 1):
        alpha = step / steps
        mu_interp = (1 - alpha) * mu_a + alpha * mu_b      # (128,)
        # Add small noise to make each sample distinct
        z = mu_interp.unsqueeze(0).expand(n_samples, -1) + \
            torch.randn(n_samples, 128, device=device) * 0.1

        _, rate = _decode_and_detect(decoder, ids_model, z, class_a, device)
        label = (
            CLASS_NAMES[class_a] if alpha == 0
            else CLASS_NAMES[class_b] if alpha == 1
            else f"mix ({alpha:.1f})"
        )
        print(f"{alpha:>6.2f}  {rate:>14.1%}  {label}")


# ══════════════════════════════════════════════════════════════════════════════
#  Experiment 2: Centroid perturbation
# ══════════════════════════════════════════════════════════════════════════════

def experiment_perturbation(
    decoder: CVAEDecoder,
    ids_model: CNN_LSTM_IDS,
    centroids: dict[int, np.ndarray],
    class_id: int,
    n_samples: int,
    device: torch.device,
) -> None:
    """
    Generate attack variants by adding increasing Gaussian noise to the centroid.
    Higher noise = further from the class distribution = more evasive.
    """
    print(f"\n[Experiment 2] Centroid perturbation: {CLASS_NAMES[class_id]}")
    print(f"{'Noise σ':>8}  {'Detection Rate':>15}")
    print("-" * 30)

    mu = torch.tensor(centroids[class_id], device=device)
    for sigma in [0.0, 0.1, 0.5, 1.0, 2.0, 5.0]:
        z = mu.unsqueeze(0).expand(n_samples, -1) + \
            torch.randn(n_samples, 128, device=device) * sigma
        _, rate = _decode_and_detect(decoder, ids_model, z, class_id, device)
        print(f"{sigma:>8.1f}  {rate:>14.1%}")


# ══════════════════════════════════════════════════════════════════════════════
#  Experiment 3: Multi-class hybrid mixing
# ══════════════════════════════════════════════════════════════════════════════

def experiment_hybrid(
    decoder: CVAEDecoder,
    ids_model: CNN_LSTM_IDS,
    centroids: dict[int, np.ndarray],
    mix_classes: list[int],
    n_samples: int,
    device: torch.device,
) -> None:
    """
    Equal-weight mixture of multiple class centroids.
    Use the first class as the condition (stealthy variant of that attack type).
    """
    names = [CLASS_NAMES[c] for c in mix_classes]
    print(f"\n[Experiment 3] Hybrid mix: {' + '.join(names)}")

    mu_mix = np.mean([centroids[c] for c in mix_classes], axis=0)
    z = torch.tensor(mu_mix, device=device).unsqueeze(0).expand(n_samples, -1) + \
        torch.randn(n_samples, 128, device=device) * 0.2

    _, rate = _decode_and_detect(decoder, ids_model, z, mix_classes[0], device)
    print(f"  Detection rate for hybrid: {rate:.1%}")


# ══════════════════════════════════════════════════════════════════════════════
#  Main
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="Novel attack generation via latent interpolation")
    parser.add_argument("--class-a", type=int, default=1,
                        help="Source class ID for interpolation (default: 1 = dos hulk)")
    parser.add_argument("--class-b", type=int, default=6,
                        help="Target class ID for interpolation (default: 6 = ddos)")
    parser.add_argument("--steps", type=int, default=10,
                        help="Interpolation steps (default: 10)")
    parser.add_argument("--samples", type=int, default=200,
                        help="Samples per experiment step (default: 200)")
    parser.add_argument("--device", type=str, default="cpu")
    args = parser.parse_args()

    device = torch.device(args.device if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    decoder = _load_decoder(device)
    ids_model = _load_ids_model(device)
    centroids = _load_centroids()

    print(f"\nLoaded centroids for {len(centroids)} classes")

    # Run all 3 experiments
    experiment_interpolation(
        decoder, ids_model, centroids,
        class_a=args.class_a, class_b=args.class_b,
        steps=args.steps, n_samples=args.samples, device=device,
    )
    experiment_perturbation(
        decoder, ids_model, centroids,
        class_id=args.class_a,
        n_samples=args.samples, device=device,
    )
    experiment_hybrid(
        decoder, ids_model, centroids,
        mix_classes=[1, 6],   # dos hulk + ddos
        n_samples=args.samples, device=device,
    )
    experiment_hybrid(
        decoder, ids_model, centroids,
        mix_classes=[10, 11, 14],  # infiltration + heartbleed + sql injection (rare)
        n_samples=args.samples, device=device,
    )

    print("\nDone.")


if __name__ == "__main__":
    main()
