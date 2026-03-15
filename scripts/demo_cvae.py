#!/usr/bin/env python3
"""
CVAE Synthetic Traffic Generator — Interactive Demo.

Demonstrates the CVAE model trained on the full CIC-IDS2017 dataset (15 attack
classes, 2.83 M rows).  Intended for project panel presentations.

Sections:
  1. Banner + model training report
  2. Interactive menu (15 classes + novel generation options)
  3. Live traffic generation with feature statistics
  4. IDS detection scoring of generated samples

Usage:
    python scripts/demo_cvae.py
    python scripts/demo_cvae.py --batch 256 --top-features 8

Requirements (all in model/):
    model/cvae_decoder.pt
    model/cvae_class_centroids.pkl
    model/cvae_scaler.pkl
    model/global_final.pt  OR  model/cnn_lstm_global_with_HE_25rounds_16k.pt
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path

# Suppress sklearn version mismatch warning when loading older pickled scalers
warnings.filterwarnings("ignore", category=UserWarning, module="sklearn")

import joblib
import numpy as np
import torch
import torch.nn.functional as F

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from fl_common.cvae import CVAEDecoder, CLASS_NAMES, NUM_CLASSES, FEATURE_NAMES  # noqa: E402
from fl_common.model import CNN_LSTM_IDS                           # noqa: E402

MODEL_DIR = PROJECT_ROOT / "model"
DECODER_PATH   = MODEL_DIR / "cvae_decoder.pt"
CENTROIDS_PATH = MODEL_DIR / "cvae_class_centroids.pkl"
SCALER_PATH    = MODEL_DIR / "cvae_scaler.pkl"
IDS_CANDIDATES = [
    MODEL_DIR / "global_final.pt",
    MODEL_DIR / "cnn_lstm_global_with_HE_25rounds_16k.pt",
]

# ── Training report constants (extracted from Kaggle v7 log) ─────────────────
TRAIN_REPORT = {
    "dataset":         "CIC-IDS2017 (full, 8 CSV files)",
    "total_rows":      2_830_743,
    "epochs":          100,
    "best_epoch":      96,
    "best_recon_loss": 0.12400,
    "final_kl":        0.08052,
    "final_aux_loss":  0.00211,
    "train_time_min":  82,
    "hardware":        "Tesla P100-PCIE-16GB (Kaggle)",
    "batch_size":      512,
    "latent_dim":      128,
    "seq_len":         10,
    "num_features":    78,
}

CLASS_COUNTS: dict[str, int] = {
    "benign":                    2_273_097,
    "dos hulk":                    231_073,
    "dos goldeneye":                10_293,
    "dos slowloris":                 5_796,
    "dos slowhttptest":              5_499,
    "portscan":                    158_930,
    "ddos":                        128_027,
    "ftp patator":                   7_938,
    "ssh patator":                   5_897,
    "bot":                           1_966,
    "infiltration":                     36,
    "heartbleed":                       11,
    "web attack brute force":        1_507,
    "web attack xss":                  652,
    "web attack sql injection":         21,
}

# ══════════════════════════════════════════════════════════════════════════════
#  Helpers — model loading
# ══════════════════════════════════════════════════════════════════════════════

def _load_decoder(device: torch.device) -> CVAEDecoder:
    if not DECODER_PATH.exists():
        _die(f"Decoder not found: {DECODER_PATH}\nRun Kaggle training first.")
    decoder = CVAEDecoder()
    decoder.load_state_dict(torch.load(str(DECODER_PATH), map_location=device, weights_only=True))
    return decoder.to(device).eval()


def _load_ids_model(device: torch.device) -> CNN_LSTM_IDS:
    for path in IDS_CANDIDATES:
        if path.exists():
            model = CNN_LSTM_IDS()
            state = torch.load(str(path), map_location=device, weights_only=True)
            if isinstance(state, dict) and "model_state_dict" in state:
                state = state["model_state_dict"]
            model.load_state_dict(state)
            return model.to(device).eval()
    _die("No IDS model found in model/.")
    raise RuntimeError  # unreachable — satisfies type checker


def _load_centroids() -> dict[int, np.ndarray]:
    if not CENTROIDS_PATH.exists():
        _die(f"Centroids not found: {CENTROIDS_PATH}")
    return joblib.load(str(CENTROIDS_PATH))


def _load_scaler():
    if not SCALER_PATH.exists():
        _die(f"Scaler not found: {SCALER_PATH}")
    return joblib.load(str(SCALER_PATH))


def _die(msg: str) -> None:
    print(f"\nERROR: {msg}")
    sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════════
#  Section 1 — Banner + training report
# ══════════════════════════════════════════════════════════════════════════════

def print_banner() -> None:
    print()
    print("=" * 70)
    print("  IoT IDS — CVAE Synthetic Traffic Generator (v7)")
    print("  FYP 2026 | Federated Learning + Homomorphic Encryption")
    print("=" * 70)


def print_training_report(centroids: dict[int, np.ndarray]) -> None:
    r = TRAIN_REPORT
    print("\n--- Model Training Report ---")
    print(f"  Dataset          : {r['dataset']}")
    print(f"  Total rows       : {r['total_rows']:,}")
    print(f"  Epochs           : {r['epochs']}")
    print(f"  Best epoch       : {r['best_epoch']} (lowest reconstruction loss)")
    print(f"  Recon loss (MSE) : {r['best_recon_loss']:.5f}  [lower is better]")
    print(f"  KL divergence    : {r['final_kl']:.5f}  [well-regularised < 0.1]")
    print(f"  Aux class. loss  : {r['final_aux_loss']:.5f}  [near-zero = strong separation]")
    print(f"  Train time       : ~{r['train_time_min']} min on {r['hardware']}")
    print()
    print("  Architecture:")
    print(f"    Encoder  : Conv1d(78→64) → LSTM(hidden=128) → FC(128→256) → (mu, log_var:{r['latent_dim']})")
    print(f"    Decoder  : Linear({r['latent_dim']}+15→256)→BN → Linear(256→512)→BN → Linear(512→780)")
    print(f"    Latent   : {r['latent_dim']}D Gaussian, class-conditional via one-hot")
    print(f"    Output   : ({r['seq_len']} timesteps × {r['num_features']} features)")
    print()
    print("  Class distribution (training) & latent centroid norms:")
    print(f"  {'ID':>3}  {'Class':<30}  {'Samples':>9}  {'Centroid |mu|':>13}")
    print("  " + "-" * 62)
    for cls_id, name in enumerate(CLASS_NAMES):
        count = CLASS_COUNTS.get(name, 0)
        norm  = float(np.linalg.norm(centroids[cls_id]))
        rare  = "  (rare)" if count < 100 else ""
        print(f"  {cls_id:>3}  {name:<30}  {count:>9,}  {norm:>13.4f}{rare}")
    print()


# ══════════════════════════════════════════════════════════════════════════════
#  Section 2 — Interactive menu
# ══════════════════════════════════════════════════════════════════════════════

MENU_EXTRA: list[tuple[str, str]] = [
    ("16", "Novel attack — interpolate two classes"),
    ("17", "Novel attack — centroid perturbation sweep"),
    ("18", "Batch generate all 15 classes (detection summary)"),
    ("0",  "Exit"),
]


def print_menu() -> None:
    print("\n--- Traffic Type Menu ---")
    print(f"  {'ID':>3}  {'Class':<35}  {'Samples':>9}")
    print("  " + "-" * 52)
    for cls_id, name in enumerate(CLASS_NAMES):
        count = CLASS_COUNTS.get(name, 0)
        print(f"  {cls_id:>3}  {name:<35}  {count:>9,}")
    print()
    for code, desc in MENU_EXTRA:
        print(f"  {code:>3}  {desc}")
    print()


def get_menu_choice() -> str:
    while True:
        raw = input("  Select [0-18]: ").strip()
        valid = {str(i) for i in range(19)} | {"0"}
        if raw in valid:
            return raw
        print(f"  Invalid choice '{raw}'. Enter a number 0-18.")


# ══════════════════════════════════════════════════════════════════════════════
#  Section 3 — Generation helpers
# ══════════════════════════════════════════════════════════════════════════════

@torch.no_grad()
def generate(
    decoder: CVAEDecoder,
    z: torch.Tensor,
    class_id: int,
    device: torch.device,
) -> torch.Tensor:
    """Decode z with class condition → (B, T, F) tensor."""
    cond = F.one_hot(
        torch.full((len(z),), class_id, dtype=torch.long, device=device),
        num_classes=NUM_CLASSES,
    ).float()
    return decoder(z, cond)


@torch.no_grad()
def score_ids(
    ids_model: CNN_LSTM_IDS,
    samples: torch.Tensor,
    threshold: float = 0.5,
) -> tuple[float, float]:
    """
    Run IDS classifier on samples.

    Returns:
        detection_rate : fraction of samples flagged as attack
        mean_prob      : average sigmoid probability
    """
    logits = ids_model(samples)
    probs = torch.sigmoid(logits).squeeze(-1)
    detection_rate = float((probs >= threshold).float().mean())
    mean_prob = float(probs.mean())
    return detection_rate, mean_prob


def z_from_centroid(
    centroid: np.ndarray,
    n: int,
    sigma: float,
    device: torch.device,
) -> torch.Tensor:
    mu = torch.tensor(centroid, dtype=torch.float32, device=device)
    return mu.unsqueeze(0).expand(n, -1) + torch.randn(n, len(centroid), device=device) * sigma


def print_feature_stats(
    samples: torch.Tensor,
    scaler,
    top_k: int = 10,
    class_name: str = "",
) -> None:
    """
    Inverse-transform samples and print stats for the top-k most varied features.
    scaler: sklearn StandardScaler (may be None — prints scaled stats then).
    """
    arr = samples.cpu().numpy().reshape(-1, samples.shape[-1])  # (B*T, F)

    if scaler is not None:
        try:
            arr_orig = scaler.inverse_transform(arr)
        except Exception:
            arr_orig = arr
    else:
        arr_orig = arr

    stds = arr_orig.std(axis=0)
    top_idx = np.argsort(stds)[::-1][:top_k]

    header = f"  Feature statistics — {class_name}" if class_name else "  Feature statistics"
    print(header)
    print(f"  {'Feature':<30}  {'Mean':>12}  {'Std':>12}  {'Min':>12}  {'Max':>12}")
    print("  " + "-" * 82)
    for i in top_idx:
        col = arr_orig[:, i]
        name = FEATURE_NAMES[i][:30] if i < len(FEATURE_NAMES) else f"feat_{i}"
        print(
            f"  {name:<30}  {col.mean():>12.4f}  {col.std():>12.4f}"
            f"  {col.min():>12.4f}  {col.max():>12.4f}"
        )


# ══════════════════════════════════════════════════════════════════════════════
#  Generation flows (called from main loop)
# ══════════════════════════════════════════════════════════════════════════════

def run_single_class(
    class_id: int,
    batch: int,
    decoder: CVAEDecoder,
    ids_model: CNN_LSTM_IDS,
    centroids: dict[int, np.ndarray],
    scaler,
    device: torch.device,
    top_features: int,
) -> None:
    name = CLASS_NAMES[class_id]
    print(f"\nGenerating {batch} samples of class [{class_id}] '{name}' ...")
    z = z_from_centroid(centroids[class_id], batch, sigma=0.3, device=device)
    samples = generate(decoder, z, class_id, device)
    det_rate, mean_prob = score_ids(ids_model, samples)
    print(f"  IDS detection rate : {det_rate:.1%}  (mean probability: {mean_prob:.3f})")
    print_feature_stats(samples, scaler, top_k=top_features, class_name=name)


def run_interpolation(
    decoder: CVAEDecoder,
    ids_model: CNN_LSTM_IDS,
    centroids: dict[int, np.ndarray],
    device: torch.device,
    n_samples: int,
) -> None:
    print("\n  Interpolation: pick two classes to blend.")
    class_a = _pick_class("  Source class ID: ")
    class_b = _pick_class("  Target class ID: ")
    steps   = _pick_int("  Number of steps [default 8]: ", default=8, lo=2, hi=20)

    name_a, name_b = CLASS_NAMES[class_a], CLASS_NAMES[class_b]
    print(f"\n  Interpolating {name_a} → {name_b} in {steps} steps\n")
    print(f"  {'Alpha':>6}  {'IDS detect':>11}  {'Mean P':>8}  Description")
    print("  " + "-" * 44)

    mu_a = torch.tensor(centroids[class_a], device=device)
    mu_b = torch.tensor(centroids[class_b], device=device)

    for step in range(steps + 1):
        alpha = step / steps
        mu_interp = (1 - alpha) * mu_a + alpha * mu_b
        z = mu_interp.unsqueeze(0).expand(n_samples, -1) + \
            torch.randn(n_samples, 128, device=device) * 0.15
        with torch.no_grad():
            samples = generate(decoder, z, class_a, device)
        det_rate, mean_prob = score_ids(ids_model, samples)
        label = (
            name_a if alpha == 0.0
            else name_b if alpha == 1.0
            else f"mix({alpha:.2f})"
        )
        print(f"  {alpha:>6.2f}  {det_rate:>10.1%}  {mean_prob:>8.3f}  {label}")


def run_perturbation_sweep(
    decoder: CVAEDecoder,
    ids_model: CNN_LSTM_IDS,
    centroids: dict[int, np.ndarray],
    device: torch.device,
    n_samples: int,
) -> None:
    class_id = _pick_class("  Class to perturb (ID): ")
    name = CLASS_NAMES[class_id]
    print(f"\n  Perturbation sweep for '{name}'\n")
    print(f"  {'Noise σ':>8}  {'IDS detect':>11}  {'Mean P':>8}  Note")
    print("  " + "-" * 48)

    for sigma in [0.0, 0.1, 0.3, 0.5, 1.0, 2.0, 5.0]:
        z = z_from_centroid(centroids[class_id], n_samples, sigma=sigma, device=device)
        with torch.no_grad():
            samples = generate(decoder, z, class_id, device)
        det_rate, mean_prob = score_ids(ids_model, samples)
        note = (
            "exact centroid" if sigma == 0.0
            else "tight cluster" if sigma <= 0.3
            else "broad sample" if sigma <= 1.0
            else "far off-distribution"
        )
        print(f"  {sigma:>8.1f}  {det_rate:>10.1%}  {mean_prob:>8.3f}  {note}")


def run_batch_all_classes(
    decoder: CVAEDecoder,
    ids_model: CNN_LSTM_IDS,
    centroids: dict[int, np.ndarray],
    device: torch.device,
    n_samples: int,
) -> None:
    print(f"\n  Generating {n_samples} samples per class (all 15 classes) ...\n")
    print(f"  {'ID':>3}  {'Class':<30}  {'IDS detect':>11}  {'Mean P':>8}")
    print("  " + "-" * 58)

    for cls_id, name in enumerate(CLASS_NAMES):
        z = z_from_centroid(centroids[cls_id], n_samples, sigma=0.3, device=device)
        with torch.no_grad():
            samples = generate(decoder, z, cls_id, device)
        det_rate, mean_prob = score_ids(ids_model, samples)
        print(f"  {cls_id:>3}  {name:<30}  {det_rate:>10.1%}  {mean_prob:>8.3f}")


# ══════════════════════════════════════════════════════════════════════════════
#  Input helpers
# ══════════════════════════════════════════════════════════════════════════════

def _pick_class(prompt: str) -> int:
    while True:
        raw = input(prompt).strip()
        try:
            val = int(raw)
            if 0 <= val <= 14:
                return val
        except ValueError:
            pass
        print(f"  Enter a class ID 0-14.")


def _pick_int(prompt: str, default: int, lo: int, hi: int) -> int:
    raw = input(prompt).strip()
    if not raw:
        return default
    try:
        val = int(raw)
        if lo <= val <= hi:
            return val
    except ValueError:
        pass
    return default


# ══════════════════════════════════════════════════════════════════════════════
#  Main
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="CVAE interactive demo")
    parser.add_argument("--batch", type=int, default=256,
                        help="Samples per generation call (default: 256)")
    parser.add_argument("--top-features", type=int, default=10,
                        help="Top varied features to display in stats (default: 10)")
    parser.add_argument("--device", type=str, default="cpu",
                        help="Torch device (default: cpu)")
    args = parser.parse_args()

    device = torch.device(args.device if torch.cuda.is_available() else "cpu")

    print_banner()
    print(f"\nLoading models (device: {device}) ...")

    decoder   = _load_decoder(device)
    ids_model = _load_ids_model(device)
    centroids = _load_centroids()
    scaler    = _load_scaler() if SCALER_PATH.exists() else None

    print(f"  Decoder       : {DECODER_PATH.name}  ({DECODER_PATH.stat().st_size // 1024} KB)")
    ids_path = next(p for p in IDS_CANDIDATES if p.exists())
    print(f"  IDS model     : {ids_path.name}  ({ids_path.stat().st_size // 1024} KB)")
    print(f"  Centroids     : {len(centroids)} classes")
    print(f"  Scaler        : {'loaded' if scaler is not None else 'not found (raw scaled values shown)'}")

    print_training_report(centroids)

    # ── Interactive loop ──────────────────────────────────────────────────────
    while True:
        print_menu()
        choice = get_menu_choice()

        if choice == "0":
            print("\nExiting. Goodbye.\n")
            break
        elif choice == "16":
            run_interpolation(decoder, ids_model, centroids, device, n_samples=args.batch)
        elif choice == "17":
            run_perturbation_sweep(decoder, ids_model, centroids, device, n_samples=args.batch)
        elif choice == "18":
            run_batch_all_classes(decoder, ids_model, centroids, device, n_samples=args.batch)
        else:
            class_id = int(choice)
            run_single_class(
                class_id, args.batch, decoder, ids_model,
                centroids, scaler, device, args.top_features,
            )

        input("\n  [Press Enter to return to menu]")


if __name__ == "__main__":
    main()
