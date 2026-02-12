"""
Analyze generated synthetic traffic windows and report per-feature anomaly/missing stats.

Usage:
  python scripts/analyze_generated_traffic.py [path/to/synthetic_windows.jsonl]

Writes CSV and JSON summary to `scripts/output/`.
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from pathlib import Path
from typing import Dict, List

try:
    from backend.app.services.explainability import BENIGN_BASELINE, FEATURE_NAMES
except Exception:
    # Fallback minimal mappings if import fails
    BENIGN_BASELINE = {
        0: 10.0, 1: 8.0, 2: 500.0, 3: 400.0, 4: 1000.0, 5: 100.0,
        6: 10.0, 7: 8.0, 8: 50.0, 9: 20.0, 10: 200.0, 11: 500.0, 12: 100.0,
        20: 1.0, 21: 2.0, 22: 0.0, 23: 5.0, 24: 10.0, 25: 0.0,
    }
    FEATURE_NAMES = {i: f"Feature_{i}" for i in range(78)}

NUM_FEATURES = 78
ANOMALY_THRESHOLD = 3.0


def is_missing(v) -> bool:
    return v is None or (isinstance(v, float) and math.isnan(v))


def analyze(path: Path) -> Dict[int, Dict]:
    stats = {i: {"total_windows": 0, "missing": 0, "anomaly_windows": 0, "ratios": []} for i in range(NUM_FEATURES)}

    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            window = obj.get("window", [])
            # Count per-feature presence/anomaly
            for feat_idx in range(NUM_FEATURES):
                stats[feat_idx]["total_windows"] += 1

                # collect values across window
                vals = [row[feat_idx] if feat_idx < len(row) else None for row in window]

                if any(is_missing(v) for v in vals):
                    stats[feat_idx]["missing"] += 1

                # Check if any value in window is anomalous relative to baseline
                baseline = BENIGN_BASELINE.get(feat_idx, 0.0)
                anomalous = False
                for v in vals:
                    if is_missing(v):
                        continue
                    try:
                        v_float = float(v)
                    except Exception:
                        continue

                    if baseline == 0.0:
                        if v_float > 0:
                            anomalous = True
                            stats[feat_idx]["ratios"].append(999.0)
                            break
                    else:
                        ratio = v_float / baseline
                        if ratio > ANOMALY_THRESHOLD:
                            anomalous = True
                            stats[feat_idx]["ratios"].append(ratio)
                            break

                if anomalous:
                    stats[feat_idx]["anomaly_windows"] += 1

    return stats


def summarize(stats: Dict[int, Dict]) -> List[Dict]:
    rows = []
    for i in range(NUM_FEATURES):
        entry = stats[i]
        total = entry["total_windows"]
        missing = entry["missing"]
        anomalous = entry["anomaly_windows"]
        ratios = entry["ratios"]
        avg_ratio = round(float(statistics.mean(ratios)), 2) if ratios else None
        rows.append({
            "index": i,
            "feature": FEATURE_NAMES.get(i, f"Feature_{i}"),
            "total_windows": total,
            "missing_count": missing,
            "missing_pct": round(missing / total * 100, 2) if total else 0.0,
            "anomaly_windows": anomalous,
            "anomaly_pct": round(anomalous / total * 100, 2) if total else 0.0,
            "avg_ratio_when_anomalous": avg_ratio,
        })
    return rows


def write_outputs(rows: List[Dict], out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "feature_anomaly_summary.csv"
    json_path = out_dir / "feature_anomaly_summary.json"

    # CSV header
    headers = ["index", "feature", "total_windows", "missing_count", "missing_pct", "anomaly_windows", "anomaly_pct", "avg_ratio_when_anomalous"]
    with csv_path.open("w", encoding="utf-8") as fh:
        fh.write(",".join(headers) + "\n")
        for r in rows:
            line = ",".join(str(r.get(h, "")) for h in headers)
            fh.write(line + "\n")

    with json_path.open("w", encoding="utf-8") as fh:
        json.dump(rows, fh, indent=2)

    print(f"Wrote: {csv_path}")
    print(f"Wrote: {json_path}")


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("logs/synthetic_windows.jsonl")
    if not src.exists():
        print(f"Source file not found: {src}")
        return

    stats = analyze(src)
    rows = summarize(stats)
    out = Path("scripts/output")
    write_outputs(rows, out)

    # Print top features by anomaly % (desc)
    rows_sorted = sorted(rows, key=lambda x: x["anomaly_pct"], reverse=True)
    print("\nTop features by anomaly percentage:")
    for r in rows_sorted[:10]:
        print(f"{r['feature']} (idx={r['index']}): {r['anomaly_pct']}% anomalies, missing {r['missing_pct']}%")


if __name__ == "__main__":
    main()
