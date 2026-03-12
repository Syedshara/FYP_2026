"""
Attack engine entrypoint — reads env vars, dispatches to the correct
attack module, and reports results back to the backend API.

Environment variables (set by attack_service.py → Docker create):
  ATTACK_CATEGORY   ddos | mitm | port-scan | replay | malformed | botnet | iot-protocol
  ATTACK_SUB_TYPE   e.g. syn_flood, arp_spoof, mqtt_publish
  TARGET_IP         Target IP address
  TARGET_PORT       Target port (default 80)
  DURATION          Seconds to run (default 30)
  INTENSITY         low | medium | high (default medium)
  ATTACK_PARAMS     JSON blob with attack-specific parameters
  RUN_ID            Database run ID for status reporting
  BACKEND_URL       Backend base URL (e.g. http://iot_ids_backend:8000)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
from importlib import import_module

import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("attack_engine")

# ── Intensity → packet rate multiplier ───────────────────
INTENSITY_MULTIPLIER = {
    "low": 0.25,
    "medium": 1.0,
    "high": 4.0,
}

# ── Category → module mapping ────────────────────────────
CATEGORY_MODULE = {
    "ddos": "attacks.ddos",
    "mitm": "attacks.mitm",
    "port-scan": "attacks.port_scan",
    "replay": "attacks.replay",
    "malformed": "attacks.malformed",
    "botnet": "attacks.botnet",
    "iot-protocol": "attacks.iot_protocol",
}


def report_status(
    backend_url: str,
    run_id: str,
    status: str,
    **extra,
) -> None:
    """POST status update to backend internal endpoint."""
    url = f"{backend_url}/api/v1/internal/attack-run-status"
    payload = {"run_id": int(run_id), "status": status, **extra}
    try:
        resp = httpx.post(url, json=payload, timeout=10)
        log.info("Reported status=%s to backend (HTTP %d)", status, resp.status_code)
    except Exception as exc:
        log.warning("Failed to report status to backend: %s", exc)


def main() -> None:
    # ── Read env vars ────────────────────────────────────
    category = os.environ.get("ATTACK_CATEGORY", "")
    sub_type = os.environ.get("ATTACK_SUB_TYPE", "")
    target_ip = os.environ.get("TARGET_IP", "10.0.0.1")
    target_port = int(os.environ.get("TARGET_PORT", "80"))
    duration = float(os.environ.get("DURATION", "30"))
    intensity = os.environ.get("INTENSITY", "medium")
    params_raw = os.environ.get("ATTACK_PARAMS", "{}")
    run_id = os.environ.get("RUN_ID", "0")
    backend_url = os.environ.get("BACKEND_URL", "http://iot_ids_backend:8000")

    try:
        params = json.loads(params_raw)
    except json.JSONDecodeError:
        params = {}

    rate_multiplier = INTENSITY_MULTIPLIER.get(intensity, 1.0)

    log.info(
        "Starting attack: category=%s sub_type=%s target=%s:%d duration=%.0fs intensity=%s",
        category, sub_type, target_ip, target_port, duration, intensity,
    )

    # ── Resolve attack module ────────────────────────────
    module_path = CATEGORY_MODULE.get(category)
    if not module_path:
        msg = f"Unknown attack category: {category!r}"
        log.error(msg)
        report_status(backend_url, run_id, "failed", error_message=msg)
        sys.exit(1)

    try:
        mod = import_module(module_path)
    except ImportError as exc:
        msg = f"Failed to import {module_path}: {exc}"
        log.error(msg)
        report_status(backend_url, run_id, "failed", error_message=msg)
        sys.exit(1)

    # Each module exposes run_attack(sub_type, target_ip, target_port, duration,
    #                                rate_multiplier, params) → dict
    run_fn = getattr(mod, "run_attack", None)
    if run_fn is None:
        msg = f"Module {module_path} has no run_attack() function"
        log.error(msg)
        report_status(backend_url, run_id, "failed", error_message=msg)
        sys.exit(1)

    # ── Execute attack ───────────────────────────────────
    report_status(backend_url, run_id, "running")
    start_time = time.time()

    try:
        result = run_fn(
            sub_type=sub_type,
            target_ip=target_ip,
            target_port=target_port,
            duration=duration,
            rate_multiplier=rate_multiplier,
            params=params,
        )
    except Exception as exc:
        elapsed = time.time() - start_time
        msg = f"Attack failed after {elapsed:.1f}s: {exc}\n{traceback.format_exc()}"
        log.error(msg)
        report_status(
            backend_url, run_id, "failed",
            error_message=str(exc),
            duration_seconds=elapsed,
        )
        sys.exit(1)

    elapsed = time.time() - start_time

    # ── Report results ───────────────────────────────────
    packets_sent = result.get("packets_sent", 0)
    log.info(
        "Attack completed: %d packets sent in %.1fs (%.0f pps)",
        packets_sent, elapsed, packets_sent / max(elapsed, 0.01),
    )

    report_status(
        backend_url, run_id, "completed",
        duration_seconds=elapsed,
        packets_sent=packets_sent,
        results=result,
    )


if __name__ == "__main__":
    main()
