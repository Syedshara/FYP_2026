#!/usr/bin/env python3
"""
Generate a teammate-friendly PDF guide for the IDS model training workflow.

This script builds docs/model-study-guide.pdf directly using matplotlib's
PDF backend (no pandoc/wkhtmltopdf dependency).

Usage:
    python scripts/generate_model_study_pdf.py
    python scripts/generate_model_study_pdf.py --output docs/model-study-guide.pdf
"""

from __future__ import annotations

import argparse
import json
import textwrap
from datetime import datetime, timezone
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = PROJECT_ROOT / "docs" / "assets"


def _read_json(path: Path) -> object:
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _draw_text_page(pdf: PdfPages, title: str, lines: list[str], footer: str | None = None) -> None:
    fig = plt.figure(figsize=(8.27, 11.69))  # A4 portrait in inches
    ax = fig.add_axes([0, 0, 1, 1])
    ax.axis("off")

    ax.text(0.06, 0.96, title, fontsize=18, fontweight="bold", va="top")

    y = 0.92
    line_height = 0.021
    for raw in lines:
        wrapped = textwrap.wrap(raw, width=102) if raw else [""]
        for line in wrapped:
            ax.text(0.06, y, line, fontsize=10.5, va="top", family="DejaVu Sans")
            y -= line_height
            if y < 0.08:
                break
        if y < 0.08:
            break
        y -= 0.005

    if footer:
        ax.text(0.06, 0.03, footer, fontsize=8.5, color="#555555", va="bottom")

    pdf.savefig(fig)
    plt.close(fig)


def _draw_image_page(pdf: PdfPages, title: str, image_path: Path, caption: str) -> bool:
    if not image_path.exists():
        return False

    img = plt.imread(image_path)
    fig = plt.figure(figsize=(8.27, 11.69))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.axis("off")
    ax.text(0.06, 0.96, title, fontsize=16, fontweight="bold", va="top")

    img_ax = fig.add_axes([0.08, 0.17, 0.84, 0.72])
    img_ax.imshow(img)
    img_ax.axis("off")

    ax.text(0.06, 0.09, caption, fontsize=10, va="top", family="DejaVu Sans")
    pdf.savefig(fig)
    plt.close(fig)
    return True


def _build_summary_block(history: list[dict]) -> list[str]:
    rounds = [entry.get("round") for entry in history if isinstance(entry.get("round"), int)]
    aggs = [entry.get("aggregation") for entry in history if isinstance(entry.get("aggregation"), str)]
    agg_times = [entry.get("aggregation_time_sec") for entry in history if isinstance(entry.get("aggregation_time_sec"), (float, int))]
    losses = [entry.get("global_loss") for entry in history if isinstance(entry.get("global_loss"), (float, int))]
    accs = [entry.get("global_accuracy") for entry in history if isinstance(entry.get("global_accuracy"), (float, int))]

    min_round = min(rounds) if rounds else None
    max_round = max(rounds) if rounds else None
    avg_time = (sum(float(x) for x in agg_times) / len(agg_times)) if agg_times else None

    agg_counts: dict[str, int] = {}
    for a in aggs:
        agg_counts[a] = agg_counts.get(a, 0) + 1

    lines = [
        "Training History Snapshot:",
        f"- Entries in model/fl_training_history.json: {len(history)}",
        f"- Round range recorded: {min_round} to {max_round}" if min_round is not None else "- Round range recorded: not available",
        f"- Average aggregation time: {avg_time:.4f} sec" if avg_time is not None else "- Average aggregation time: not available",
        f"- Aggregation types in history: {agg_counts if agg_counts else 'not available'}",
        f"- Global loss points available: {len(losses)}",
        f"- Global accuracy points available: {len(accs)}",
        "",
        "Important note:",
        "- Current history file mostly contains aggregation timing metadata."
        " Loss/accuracy can still be captured from backend DB (fl_rounds) or by extending server history logging.",
    ]
    return lines


def build_pdf(output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    history = _read_json(PROJECT_ROOT / "model" / "fl_training_history.json")
    if not isinstance(history, list):
        history = []

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    with PdfPages(output_path) as pdf:
        _draw_text_page(
            pdf,
            "IoT IDS Model Training Study Guide",
            [
                "Project: FYP_2026 (CNN-LSTM IDS + Federated Learning + CKKS HE + CVAE synthetic attack generator)",
                "",
                "Purpose:",
                "- Provide your teammate a single study document for how the model is trained,"
                " what epochs/rounds are run, which layers are used, and which metrics to inspect.",
                "",
                "Core runtime files:",
                "- fl_common/model.py               (CNN-LSTM architecture)",
                "- fl_client/client.py              (client local training loop + epoch metrics)",
                "- fl_server/server.py              (round aggregation + checkpointing + history)",
                "- fl_common/cvae.py               (CVAE architecture used for synthetic attack windows)",
                "- scripts/train_cvae.py           (local CVAE training)",
                "- scripts/preprocess_cicids2017.py (feature scaling + 10-step windows + client split)",
                "",
                "Generated with scripts/generate_model_study_pdf.py",
            ],
            footer=f"Generated: {generated_at}",
        )

        _draw_text_page(
            pdf,
            "1) Data Pipeline and Feature Setup",
            [
                "Dataset and preprocessing:",
                "- Source: CIC-IDS2017 CSV files (8 daily capture files)",
                "- Preprocessing script: scripts/preprocess_cicids2017.py",
                "- Features: fixed 78-feature order (EXPECTED_FEATURES)",
                "- Labels for CNN-LSTM FL: binary (benign=0, attack=1)",
                "- Scaling: StandardScaler saved as model/standard_scaler.pkl",
                "",
                "Windowing for sequence model:",
                "- Sequence length: 10 timesteps",
                "- Window label = label of last row in each window",
                "- Output chunks per client: X_seq_chunk_*.npy and y_seq_chunk_*.npy",
                "",
                "Client partition default:",
                "- bank_a: monday + tuesday",
                "- bank_b: wednesday + thursday",
                "- bank_c: friday",
            ],
        )

        _draw_text_page(
            pdf,
            "2) CNN-LSTM Architecture Used for FL Training",
            [
                "Model file: fl_common/model.py",
                "",
                "Input/Output:",
                "- Input tensor: (batch, seq_len=10, num_features=78)",
                "- Output tensor: (batch, 1) raw logit (sigmoid applied for probability)",
                "",
                "Layers:",
                "1. Conv1d(78 -> 64, kernel_size=3, padding=1)",
                "2. ReLU",
                "3. LSTM(input_size=64, hidden_size=64, num_layers=1, batch_first=True)",
                "4. Linear(64 -> 1)",
                "",
                "Loss + threshold:",
                "- Loss: BCEWithLogitsLoss with pos_weight=5.0",
                "- Decision threshold: 0.5",
                "",
                "Parameter count (from actual model object):",
                "- Total trainable params: 48,385",
                "- conv1.weight: 14,976",
                "- conv1.bias: 64",
                "- lstm.weight_ih_l0: 16,384",
                "- lstm.weight_hh_l0: 16,384",
                "- lstm.bias_ih_l0: 256",
                "- lstm.bias_hh_l0: 256",
                "- fc.weight: 64",
                "- fc.bias: 1",
                "",
                "HE-selected layers (CKKS aggregation target):",
                "- lstm.weight_ih_l0",
                "- lstm.weight_hh_l0",
                "- fc.weight",
                "- fc.bias",
            ],
        )

        _draw_text_page(
            pdf,
            "3) Epochs, Rounds, and Training Configuration",
            [
                "Where rounds/epochs are controlled:",
                "- Backend API request model: backend/app/api/v1/fl.py (FLStartRequest)",
                "- FL server env: backend/app/services/docker_service.py (start_fl_server)",
                "- FL server runtime: fl_server/server.py",
                "- FL client local training loop: fl_client/client.py (local_train)",
                "",
                "Typical defaults used by the stack:",
                "- num_rounds: API default 5 (server fallback default config 25 if env not supplied)",
                "- local_epochs: 5",
                "- learning_rate: 0.001",
                "- batch_size: 128",
                "- max_batches: 0 (means use all batches)",
                "- min_clients: 1 (API default, can be increased)",
                "",
                "Round lifecycle:",
                "1. Server sends global weights and round config",
                "2. Client trains locally for local_epochs",
                "3. Client returns updated weights + metrics + optional signature",
                "4. Server aggregates (FedAvg plain or FedAvg+HE)",
                "5. Server checkpoints and logs round metrics",
                "",
                "Security cadence in server:",
                "- RECESS detection round every 5 rounds",
                "- VSS proactive key refresh every 20 rounds",
            ],
        )

        _draw_text_page(
            pdf,
            "4) Metrics You Should Track (Python Graphs)",
            [
                "Current generated graph files (docs/assets):",
                "- fl_aggregation_time.png",
                "- fl_aggregation_type_distribution.png",
                "- fl_round_coverage.png",
                "- fl_metrics_summary.json",
                "",
                "If history includes these keys, extra graphs are auto-generated:",
                "- global_loss -> fl_global_loss.png",
                "- global_accuracy -> fl_global_accuracy.png",
                "",
                "How to regenerate graphs:",
                "- python scripts/plot_training_metrics.py",
                "",
                "Recommended study focus for teammate:",
                "- Trend of global_loss and global_accuracy across rounds",
                "- Aggregation time growth as number of clients/HE load increases",
                "- Missing rounds/checkpoints as operational troubleshooting signals",
            ] + _build_summary_block(history),
        )

        _draw_text_page(
            pdf,
            "5) CVAE Training Model (Synthetic Attack Generator)",
            [
                "CVAE architecture file: fl_common/cvae.py",
                "Training script: scripts/train_cvae.py (local) / scripts/kaggle/train_cvae.py (full Kaggle run)",
                "",
                "CVAE purpose:",
                "- Generate synthetic attack traffic windows (10 x 78) conditioned on class ID",
                "- Used for realistic attack simulation during monitor/attack node runs",
                "",
                "CVAE architecture:",
                "Encoder: Conv1d(78->64) + ReLU + LSTM(64->128) + FC(128->256) -> mu/log_var(128)",
                "Decoder: FC((128 + 15)->256) + ReLU + BN + FC(256->512) + ReLU + BN + FC(512->780)",
                "Aux classifier: Linear(128->15) on latent mu",
                "",
                "CVAE key outputs:",
                "- model/cvae_decoder.pt",
                "- model/cvae_scaler.pkl",
                "- model/cvae_class_centroids.pkl",
                "",
                "CVAE parameter count (from model object):",
                "- Total: 785,243 | Encoder: 213,184 | Decoder: 570,124 | Aux: 1,935",
            ],
        )

        _draw_text_page(
            pdf,
            "6) How To Run End-to-End (Team Quick Start)",
            [
                "A) Setup",
                "1. ./scripts/linux/setup.sh",
                "2. Login frontend with admin / admin123",
                "",
                "B) Preprocess dataset (if needed)",
                "- python scripts/preprocess_cicids2017.py --clients 3 --window 10 --stride 1",
                "",
                "C) Start FL training from API (example)",
                "- POST /api/v1/fl/start with JSON:",
                "  {\"num_rounds\": 25, \"min_clients\": 3, \"use_he\": true, \"local_epochs\": 5, \"learning_rate\": 0.001, \"max_batches\": 0}",
                "",
                "D) Key outputs after training",
                "- model/global_final.pt",
                "- model/fl_checkpoints/global_round_*.pt",
                "- model/fl_training_history.json",
                "",
                "E) Plot metrics",
                "- python scripts/plot_training_metrics.py",
                "",
                "F) Rebuild this PDF",
                "- python scripts/generate_model_study_pdf.py",
                "",
                "Tip: Keep this PDF, the graph PNGs, and fl_training_history.json together"
                " for teammate review and presentation prep.",
            ],
        )

        _draw_image_page(
            pdf,
            "Appendix A - Aggregation Time Per Round",
            ASSETS_DIR / "fl_aggregation_time.png",
            "Generated from model/fl_training_history.json using scripts/plot_training_metrics.py",
        )
        _draw_image_page(
            pdf,
            "Appendix B - Aggregation Strategy Distribution",
            ASSETS_DIR / "fl_aggregation_type_distribution.png",
            "Shows how many history entries used each aggregation strategy.",
        )
        _draw_image_page(
            pdf,
            "Appendix C - Round Coverage",
            ASSETS_DIR / "fl_round_coverage.png",
            "Green=round present in history, Red=missing within min..max round range.",
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate model training study guide PDF")
    parser.add_argument("--output", default="docs/model-study-guide.pdf", help="Output PDF path")
    args = parser.parse_args()

    output_path = Path(args.output)
    build_pdf(output_path)
    print(f"PDF generated: {output_path}")


if __name__ == "__main__":
    main()
