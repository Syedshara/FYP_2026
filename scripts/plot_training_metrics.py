#!/usr/bin/env python3
"""
Generate Python graphs for FL training metrics.

Reads model/fl_training_history.json and outputs PNG charts into docs/assets/.

Usage:
    python scripts/plot_training_metrics.py
    python scripts/plot_training_metrics.py --history model/fl_training_history.json --out docs/assets
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import mean

import matplotlib.pyplot as plt


def _load_history(history_path: Path) -> list[dict]:
    if not history_path.exists():
        raise FileNotFoundError(f"History file not found: {history_path}")
    with history_path.open("r", encoding="utf-8") as handle:
        raw = json.load(handle)
    if not isinstance(raw, list):
        raise ValueError("History JSON must be a list of round entries")
    return [entry for entry in raw if isinstance(entry, dict)]


def _extract_numeric(history: list[dict], key: str) -> tuple[list[int], list[float]]:
    rounds: list[int] = []
    values: list[float] = []
    for item in history:
        rnd = item.get("round")
        val = item.get(key)
        if isinstance(rnd, int) and isinstance(val, (int, float)):
            rounds.append(rnd)
            values.append(float(val))
    return rounds, values


def _plot_aggregation_time(history: list[dict], out_dir: Path) -> Path | None:
    rounds, times = _extract_numeric(history, "aggregation_time_sec")
    if not rounds:
        return None

    fig, ax = plt.subplots(figsize=(10, 4.8))
    ax.plot(rounds, times, marker="o", linewidth=2)
    ax.set_title("FL Aggregation Time Per Round")
    ax.set_xlabel("Round")
    ax.set_ylabel("Aggregation Time (sec)")
    ax.set_xticks(rounds)
    for rnd, sec in zip(rounds, times):
        ax.annotate(f"{sec:.3f}s", (rnd, sec), textcoords="offset points", xytext=(0, 6), ha="center", fontsize=8)
    fig.tight_layout()
    out = out_dir / "fl_aggregation_time.png"
    fig.savefig(out, dpi=200)
    plt.close(fig)
    return out


def _plot_aggregation_distribution(history: list[dict], out_dir: Path) -> Path | None:
    counts: dict[str, int] = {}
    for item in history:
        kind = str(item.get("aggregation", "unknown"))
        counts[kind] = counts.get(kind, 0) + 1

    if not counts:
        return None

    labels = list(counts.keys())
    values = [counts[label] for label in labels]

    fig, ax = plt.subplots(figsize=(7, 4.6))
    ax.bar(labels, values)
    ax.set_title("Aggregation Strategy Distribution")
    ax.set_ylabel("Rounds Count")
    for idx, value in enumerate(values):
        ax.text(idx, value + 0.05, str(value), ha="center", va="bottom", fontsize=10)
    fig.tight_layout()
    out = out_dir / "fl_aggregation_type_distribution.png"
    fig.savefig(out, dpi=200)
    plt.close(fig)
    return out


def _plot_round_coverage(history: list[dict], out_dir: Path) -> Path | None:
    rounds = sorted(item["round"] for item in history if isinstance(item.get("round"), int))
    if not rounds:
        return None

    all_rounds = list(range(min(rounds), max(rounds) + 1))
    present = set(rounds)
    y_values = [1 if rnd in present else 0 for rnd in all_rounds]

    fig, ax = plt.subplots(figsize=(10, 2.8))
    colors = ["#16a34a" if val == 1 else "#dc2626" for val in y_values]
    ax.bar(all_rounds, y_values, color=colors, width=0.8)
    ax.set_title("History Round Coverage")
    ax.set_xlabel("Round")
    ax.set_ylabel("Present")
    ax.set_yticks([0, 1])
    ax.set_ylim(0, 1.2)
    fig.tight_layout()
    out = out_dir / "fl_round_coverage.png"
    fig.savefig(out, dpi=200)
    plt.close(fig)
    return out


def _plot_optional_metric(history: list[dict], key: str, title: str, ylabel: str, filename: str, out_dir: Path) -> Path | None:
    rounds, values = _extract_numeric(history, key)
    if not rounds:
        return None

    fig, ax = plt.subplots(figsize=(10, 4.8))
    ax.plot(rounds, values, marker="o", linewidth=2)
    ax.set_title(title)
    ax.set_xlabel("Round")
    ax.set_ylabel(ylabel)
    ax.set_xticks(rounds)
    fig.tight_layout()
    out = out_dir / filename
    fig.savefig(out, dpi=200)
    plt.close(fig)
    return out


def _write_summary(history: list[dict], out_dir: Path) -> Path:
    rounds = sorted(item["round"] for item in history if isinstance(item.get("round"), int))
    _, agg_times = _extract_numeric(history, "aggregation_time_sec")
    summary = {
        "history_entries": len(history),
        "min_round": min(rounds) if rounds else None,
        "max_round": max(rounds) if rounds else None,
        "rounds_present": rounds,
        "avg_aggregation_time_sec": mean(agg_times) if agg_times else None,
    }
    out = out_dir / "fl_metrics_summary.json"
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate FL training metric charts")
    parser.add_argument("--history", default="model/fl_training_history.json", help="Path to training history JSON")
    parser.add_argument("--out", default="docs/assets", help="Output directory for generated charts")
    args = parser.parse_args()

    history_path = Path(args.history)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    history = _load_history(history_path)

    generated: list[Path] = []
    for output in (
        _plot_aggregation_time(history, out_dir),
        _plot_aggregation_distribution(history, out_dir),
        _plot_round_coverage(history, out_dir),
        _plot_optional_metric(history, "global_loss", "Global Loss Per Round", "Loss", "fl_global_loss.png", out_dir),
        _plot_optional_metric(history, "global_accuracy", "Global Accuracy Per Round", "Accuracy", "fl_global_accuracy.png", out_dir),
    ):
        if output is not None:
            generated.append(output)

    summary_path = _write_summary(history, out_dir)

    print("Generated files:")
    for path in generated:
        print(f"  - {path}")
    print(f"  - {summary_path}")


if __name__ == "__main__":
    main()
